# 状态存储与回滚引擎（store.ts / rollback.ts）

本文件解析持久化设计：`~/.dsh/.qaq/` 目录、原子写入、PID 感知锁、快照管理，以及回滚引擎的完整决策链。

相关文档：[架构总览](architecture.md) · [守卫生命周期](guard-lifecycle.md)

---

## 1. 目录与文件

```
$DSH_HOME/.qaq/                  # qaqDir(home)
├── state.json                   # 守卫状态（原子写入）
├── .guard.lock                  # PID 感知守卫锁
├── latest-good/                 # 最近一次确认健康的配置副本
│   ├── package.json
│   ├── cordis.patch.yml
│   └── manifest.json            # { profile, ts }
├── history/<ts>/                # 时间戳历史快照（最多保留 5 份，含 manifest）
├── rolled-back/<ts>/            # 回滚前保存的坏配置（含 manifest，note 标注）
└── log/                         # 见 logging.md
```

`$DSH_HOME` 解析：`$DSH_HOME` 环境变量 → 回退 `~/.dsh`（`src/paths.ts`）。

---

## 2. state.json 结构

```jsonc
{
  "version": 1,
  "profiles": {
    "web": {
      "hostFailures": 0,           // 连续 host 失败数
      "uiFailures": 0,             // 连续 ui 失败数（同类累加，异类清零）
      "lastSuccess": "ISO-8601",
      "lastFailure": { "kind": "host|ui", "ts": "...", "error": "..." },
      "lastGoodSnapshot": "history/<ts>",   // 本 profile 的 last-good 快照引用
      "rolledBackAt": "ISO-8601"   // 防循环围栏标记；成功启动后清除
    }
  },
  "config": { "autoConfirm": false }
}
```

- **原子写入**：先写 `<path>.tmp`，再 `renameSync` 覆盖——崩溃绝不会留下半写 state。
- **读容错**：文件缺失 / 损坏 / schema 不符 → 返回默认空状态（不抛异常）。
- 计数语义：`incrementFailure` 对**同类 +1、异类清零**，保证"连续同类失败"含义正确。

---

## 3. 守卫锁（`acquireLock`）

- 锁文件内容为持有者的 PID。
- 获取时若锁存在：检查记录的 PID 是否存活（`process.kill(pid, 0)`，ESRCH=死）：
  - 存活 → 抛"另一个守卫实例在运行"；
  - 死亡（崩溃残留）→ 视为陈旧锁，删除并接管——**崩溃后下次运行自动恢复**。
- 返回释放函数；正常退出路径调用。强制 kill（关窗口）会残留锁，但下一次运行按 PID 存活检查自动回收。

---

## 4. 快照管理（store.ts）

| 函数 | 行为 |
|------|------|
| `writeSnapshot` | 复制 `package.json`（+ `cordis.patch.yml`）进快照目录，写 `manifest.json` |
| `listSnapshots` | 列出子目录中**含 manifest.json** 的合法快照，按 ISO 时间戳名排序（字典序=时间序，跨重启确定） |
| `pruneSnapshots` | 保留最新 N 份，删除其余 |
| `restoreSnapshot` | 把快照里的 `package.json` / `cordis.patch.yml` 复制回 profile 目录 |
| `isUsableSnapshot` | 有 `package.json` 即视为可用 |

> 注意：**restore 只覆盖文件，不删除 profile 里坏配置新增的文件**（设计取舍，可接受）。

---

## 5. 回滚引擎（rollback.ts）

### 5.1 `maybeRollback(ctx)` 决策链

```
threshold 判定：同类计数 < 阈值（默认 3）→ 不触发
防循环围栏：rolledBackAt 距今 < 5 分钟 → 不触发（提示手动修复）
last-good 解析：
  优先 state.lastGoodSnapshot（history/<ts>）
  其次 latest-good/（仅当 manifest.profile 与当前 profile 一致，防跨 profile 误用）
  都没有 → 不触发（提示先成功启动一次）
坏配置备份：把当前 profile 配置复制到 rolled-back/<ts>/（+ manifest 标注 note）
确认（非 autoConfirm）：
  先打印 LCS 行级 diff（当前 vs last-good）供预览
  Y/N → 拒绝则返回 cancelled（不覆盖、不重启）
执行：restoreSnapshot → 写 rolledBackAt → 记 access.log → 返回 restored
```

### 5.2 防循环围栏（anti-loop）

- `ANTI_LOOP_MS = 5 * 60 * 1000`。
- 回滚后若重启仍失败，围栏阻止 5 分钟内再次回滚（不会连环回滚/重启）。
- **成功启动会清除围栏**（`recordSuccess` 删除 `rolledBackAt`）——真成功 = 解除戒备。
- 边界：`rolledBackAt` 若为非法日期串，`Date.parse` 返回 NaN，围栏判定按"未激活"处理（数据异常不静默禁用，由运维修 state.json）。

### 5.3 `recordSuccess`

清零两个计数 → 更新 `lastSuccess` → 清除围栏 → 写 `latest-good/` + `history/<ts>/`（各带 manifest）→ 更新 `lastGoodSnapshot` → 保留 5 份历史 → 记 access.log。

---

## 6. 手动命令（cli.ts）

| 命令 | 行为 |
|------|------|
| `qaq backup` | 把当前 profile 配置快照为 last-good（复用 `recordSuccess`） |
| `qaq restore --to <snapDir>` | 从任意快照目录还原 profile（`manualRestore`） |
| `qaq reset` | 清零计数、删除 lastFailure（写 access.log） |
| `qaq status` | 打印 state 摘要 JSON |

---

## 7. 修改指南

- 改快照内容 → 同时更新 `store.ts writeSnapshot`、`packages/dsh-qaq/src/index.ts` 与 manifest 校验。
- 改回滚触发策略 → 只动 `maybeRollback` 的决策链；`test/rollback.spec.ts` 覆盖阈值、围栏、无快照、用户拒绝、成功记账等路径。
- 加字段 → 同步 `QaqState` / `ProfileState` 类型与 `readState` 的 schema 校验，避免旧 state 读取异常。
