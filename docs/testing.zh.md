# 测试与真实集成（test/ · tools/ · qaq-test-plugins/）

本文件解析质量保障体系：单测矩阵、smoke 回归、真实 DSH 集成闭环、故障注入夹具，以及如何为新增功能补测试。

相关文档：[架构总览](architecture.zh.md)

---

## 1. 测试命令

```bash
pnpm test      # vitest run —— 27 个 spec 文件，270 个用例
pnpm smoke     # 一键回归：单测 + 隔离 home 种子/破坏/守卫检测
pnpm lint      # 零依赖风格门禁（行尾空格、制表符、TODO 标记、文件末尾换行）
pnpm typecheck # tsc --noEmit
```

---

## 2. 单测矩阵（test/）

| 文件 | 覆盖点 | 关键用例 |
|------|--------|----------|
| `store.spec.ts` | 状态读写、原子性、快照、备份集、锁 | 损坏 state 回退默认；剪枝保留 5 份；manifest 记录真实 profile 名（回归）；锁互斥与释放；**`readSnapshotKind`（损坏/缺失回退 auto）、auto/manual 独立配额（10/3）、`listBackups` 空集与按集分离** |
| `paths.spec.ts` | 纯路径工具 | `resolveDshHome` 默认 vs 显式 DSH_HOME（空/去空格）；`qaqDir`；`profileDir`；`profilesNodeModules`（平台无关分隔符） |
| `cli.spec.ts` | 命令面解析 | `parseCli` 覆盖各子命令/模式、`--yes`/`--profile`、watch `--attach` 回退 `--port`、数字调优旗标（含非法数字护栏）、可重复 `--webhook`、restore `--to`；导入 CLI 不会自动跑 `main()` |
| `dsh-context.spec.ts` | 真实 DSH 发现 | 隔离 `DSH_HOME`（每 worker）；空闲 profile 解析；外部运行 DSH 通过新鲜插件心跳上报（pid/port、connected）；`profileBasename`；`describeDsh` |
| `rollback.spec.ts` | 回滚引擎 | 阈值以下不触发；触发时备份坏配置并还原；围栏阻止二次回滚；无快照不触发；用户拒绝不覆盖；recordSuccess 清零+清围栏+快照；**manualBackup 只写手动集、不改计数；auto/manual 独立配额（自动 10 / 手动 3）** |
| `guard.spec.ts` | 编排（mock spawn/detect） | UI 永不落定必须 kill 子进程（泄漏回归）；确认窗口内劣化不得记 last-good；**宿主绑定后崩溃 → 归类 host 而非 unknown（分类回归）**；retriesExhausted 语义；**确定性 UI 红屏首次即回滚（有效阈值 1）** |
| `spawn-dsh.spec.ts` | 真实子进程就绪跟踪 | 端口开启前退出 → ready 立即拒绝并给真实退出码；命令不存在 → spawn error 不干等超时 |
| `detector-ui.spec.ts` | L3 判据 | 红屏文本判 failed 且提取 detail/failedEntries；健康 composer 判 ok；启动页判 loading；**0ms 超时至少探测一次（confirm-ms 0 回归）**；**"waiting for service" 红屏判 definitive** |
| `env.spec.ts` | 环境发现 | findCheckoutCli / QAQ_DSH_CMD / --cwd checkout / **兄弟目录自动发现（checkout 与 cwd 并排）** / isPortFree |
| `install-plugin.spec.ts` | 插件挂载 | 未初始化 profile 优雅失败；真实挂载幂等 + **user patch 不被触碰**；插件目录解析 |
| `log.spec.ts` | 日志系统 | JSON 行格式、error 双写、access 通道、`.in()` 类别、按大小轮转 |
| `tui.spec.ts` | 仪表盘 | 布局不溢出；首帧才全清屏；日志/插件面板；**备份管理面板：自动/手动分群渲染、`◈` 平铺光标跨两群、空集占位**；**版本号头部显示 + 「检测更新 (Beta)」菜单位置 + 更新提示行** |
| `update.spec.ts` | 版本检测（Beta） | 版本三元组解析/比较（0.0.3→0.1.3→…→0.4.4 链条）；本地版本读取；`checkForUpdate` 用桩 fetch（更新/相同/更旧/HTTP 错误/坏载荷/网络错误）；`downloadUpdateSource` 写出 `qaq-<version>.zip` |

测试基建注意：
- `guard.spec.ts` 用 `vi.hoisted` + `vi.mock` 替换 `spawn-dsh` / `detector-ui`，断言 `killMock` 调用。
- 真实子进程测试（spawn-dsh）用 `node -e 'process.exit(3)'` 模拟早退。
- 所有 Logger 构造都在 `beforeAll`（home 就绪后），避免空 home 污染仓库目录。

---

## 3. smoke 一键回归（tools/smoke.mjs）

流程：

1. `npx vitest run`（单测全量）。
2. 隔离 home（`tools/.smoke-home`）：种子健康 profile → `qaq backup` 写 last-good → 破坏 user patch（插入不存在的包）。
3. 跑一次守卫（`qaq dsh web --yes`，`QAQ_DSH_CMD` + `--cwd` 指向真实 checkout）→ 应检测为 host 失败并退出。
4. 清理临时 home。

> - 真实 DSH 集成段**仅在提供 checkout 时执行**：`$env:QAQ_SMOKE_DSH_HOME = <checkout路径>`。
> - smoke 脚本路径全部相对 `import.meta.url`（Windows 下 spawn 需 `shell: true` 才能解析 npx.cmd）。

---

## 4. 真实 DSH 集成闭环（tools/*.ps1）

| 脚本 | 场景 |
|------|------|
| `rollback-test.ps1` | 种子健康 → `qaq backup` → 注入 dsh-broken-theme 破坏 profile → 跑 3 次守卫 → 第 3 次触发回滚 → 校验 profile 还原、state、rolled-back 内容 |
| `loop-test.ps1` | 健康启动快照 → 破坏 → 3 次守卫 → 回滚闭环（防循环路径） |

- 全部位置无关：路径由 `$PSScriptRoot` 推导；checkout 取 `$env:QAQ_SMOKE_DSH_HOME`（回退兄弟目录 `deepseek-harness`）。
- 破坏方式：profile `package.json` 增加 `dsh-broken-theme` bundle + `link:` 依赖 + junction
  指向 `qaq-test-plugins/dsh-broken-theme`。**写入必须无 BOM**（DSH YAML 解析 BOM 会炸）。

---

## 5. 故障注入夹具（qaq-test-plugins/dsh-broken-theme）

- 宿主半：`apply()` 为空（保证 entry 可解析）。
- 客户端半：声明 `dsh.client.inject: ["theme"]` 但**永远不提供该服务** → 确定性红屏
  `web boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: ...)`。
- 用途：让守卫的 UI 失败检测线在真实 DSH 上可复现地触发。

---

## 6. 真实联调流程（一次完整验证）

```
1. 隔离 home，种子健康 profile（bundles = base + web-app，patch = []）
2. qaq install-plugin --profile web    # 挂载 dsh-qaq（验证 bundle 层正确加载）
3. qaq dsh web --yes --port <N>        # 健康启动：应 lastSuccess + 快照落盘
4. 注入 dsh-broken-theme → 3 次启动    # 应 uiFailures 1→2→3 → 回滚 → 重启健康
5. 校验 state.json / latest-good / history / rolled-back / access.log
```

---

## 7. 新增测试指南

- **判据/纯函数** → `detector-ui.spec.ts` / `store.spec.ts`（直接断言）。
- **编排/时序** → `guard.spec.ts`（mock 依赖，断言分类 + kill + 状态副作用）。
- **文件系统副作用** → 用 `mkdtempSync` 隔离 home，`beforeAll/afterAll` 清理。
- **真实进程** → `spawn-dsh.spec.ts` 模式（短命子进程 + 真实退出码断言）。
- **端到端** → 扩 `smoke.mjs`（隔离 home 流程）或 `rollback-test.ps1`（真实 DSH）。
