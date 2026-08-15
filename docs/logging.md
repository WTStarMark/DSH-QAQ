# 日志系统（src/log.ts）

本文件解析结构化日志：记录格式、四通道分文件、按大小轮转，以及开发者在故障检修时的使用方式。

相关文档：[架构总览](architecture.md)

---

## 1. 记录格式

每条记录一行 JSON：

```jsonc
{ "ts": "2026-08-15T02:18:12.645Z", "level": "info", "cat": "qaq",
  "phase": "boot", "msg": "host + UI healthy; confirming for 20000ms",
  "profile": "web", ...meta }
```

- `ts`：ISO-8601 UTC；`level`：info / warn / error；
- `cat`：日志类别（qaq / rollback / ...）；`phase`：可选阶段（boot / confirm / rollback / restart）；
- 自定义 meta 键值（profile、kind、action、snapDir 等）由调用方附加，`undefined` 值被剔除。
- 单行 JSON 便于 `Select-String` / `jq` 等机器解析。

---

## 2. 四通道文件（`$DSH_HOME/.qaq/log/`）

| 文件 | 内容 | 用途 |
|------|------|------|
| `qaq.log` | 全部（info + warn + error） | 主记录 |
| `error.log` | 仅 warn / error | 快速 grep 问题 |
| `access.log` | 崩溃审计轨迹 | 启动结论、快照、回滚、重置、插件挂载、手动还原——**状态变更的唯一完整轨迹** |
| `host.log` | 被监督 dsh 的原始 stdout/stderr | 排查 dsh 自身输出；格式为 `level ts 行内容` |

写入策略：
- `info/warn/error`：写 `qaq.log`；warn/error 同时写 `error.log`；`access()` 额外写 `access.log` 并镜像到 stdout。
- `host()`：子进程输出按行前缀时间戳写 `host.log`，并镜像到可见窗口（error 走 stderr，其余走 stdout）。

---

## 3. 轮转（按大小）

- 阈值 `ROTATE_BYTES = 256 KB`；保留 `KEEP_FILES = 5` 份。
- 触发：`qaq.log → qaq.1.log → qaq.2.log …`，超出 5 份删除最旧的。
- 实现：`sizes`/`lastCheck` 做增量字节跟踪（约每 64KB 才 stat 一次），`rotateFile` 用
  `renameSync` 递推 + 正则清理超龄副本。
- **轮转是尽力而为的**：任何异常都被吞掉，绝不影响业务。

---

## 4. 日志入口约定

```ts
const log = new Logger(home)          // home 为空/空白时回退 resolveDshHome()
log.info('...') / log.warn('...') / log.error('...', meta)
log.access('状态变更', { profile, action })   // 审计轨迹
log.host(chunk, 'stdout' | 'stderr')          // 子进程原始输出
log.in('rollback') / log.at('rollback')       // 派生类别/阶段日志
```

> **空 home 回退**是硬性防线：`new Logger('')` 会把 `.qaq` 解析到 cwd 相对路径污染工作目录
> （`rollback.spec.ts` 曾因模块顶层构造触发，已修复并加注释）。

---

## 5. 检修指引

| 场景 | 看哪 |
|------|------|
| 启动结论 / 是否回滚 | `access.log` |
| 报错与告警 | `error.log` |
| dsh 自身行为 / 红屏前的输出 | `host.log` |
| 完整时间线 | `qaq.log`（含 phase 字段） |
| 控制台内查看 | `qaq console` → [7] |

示例排查（PowerShell）：

```powershell
# 最近的回滚
Select-String -Path "$HOME\.dsh\.qaq\log\access.log" -Pattern 'rolled back' | Select-Object -Last 5

# 某次启动的完整轨迹（按 phase 过滤）
Get-Content "$HOME\.dsh\.qaq\log\qaq.log" | ConvertFrom-Json | Where-Object { $_.phase -eq 'boot' }
```

---

## 6. 修改指南

- 加通道 → 扩展 `LogChannel` 与 `filePathFor`，同步 `access.log` 表（本文件第 2 节）。
- 改轮转阈值 → 只动 `ROTATE_BYTES` / `KEEP_FILES` 常量。
- 加字段 → `LogRecord` 的索引签名已允许任意 meta；调用方直接传即可。
- 测试：`test/log.spec.ts` 覆盖结构化格式、error 双写、access 通道、`.in()` 类别、轮转。
