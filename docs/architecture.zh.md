# QAQ 架构总览

本文是 QAQ（DeepSeek Harness 启动容灾守卫）的架构入口文档。二次开发请先读本文，再按需深入各专项文档。

- [守卫生命周期](guard-lifecycle.zh.md) — 一次受监督启动的完整流程
- [状态存储与回滚引擎](state-and-rollback.zh.md) — state.json / 快照 / 防循环
- [UI 检测与 CDP](ui-detection.zh.md) — headless Chrome + 真实 DOM 判据
- [懒人脚本控制台与环境发现](console-and-env.zh.md) — 交互菜单 / 环境自检 / 插件挂载
- [日志系统](logging.zh.md) — 结构化多文件轮转日志
- [测试与真实集成](testing.zh.md) — 单测矩阵 / smoke / 真实 DSH 联调

---

## 1. 项目定位

QAQ 是一个 **外部监督进程**：它以独立进程接管 `dsh web` 的启动，检测两种 DSH 无法自愈的故障形态：

| 故障形态 | 表现 | 常规监控为何抓不到 |
|----------|------|--------------------|
| **宿主崩溃** | `dsh web` 进程退出 / 端口未开 / 启动期异常 | 需要专门盯进程存活 |
| **UI 红屏** | 宿主进程正常、端口可达，但浏览器渲染 `Failed to load plugins` | `curl` 只能拿到空 `<div id="root">`，服务端 HTML 由 React 运行时填充；CSS 类名是跨构建不稳定的 hash |

QAQ 的检测线（L3）是唯一可靠的**非侵入**探测：用 headless Chrome 经 CDP 打开页面，读取真实 DOM 文本。

**非侵入承诺**：QAQ 不改 DSH 源码；备份插件只读配置、不改行为。

---

## 2. 模块地图

| 模块 | 文件 | 职责 | 关键导出 |
|------|------|------|----------|
| 命令行 | `src/cli.ts` | 命令面解析、`dsh web` 监督入口 | `main()` |
| 守卫编排 | `src/guard.ts` | 一次启动的编排：spawn → 探测 → 计数 → 回滚 | `superviseBoot()`, `GuardOptions`, `BootVerdict` |
| 子进程监督 | `src/spawn-dsh.ts` | spawn `dsh web`、就绪/退出跟踪、输出捕获 | `spawnDsh()`, `DshSupervisor` |
| CDP 客户端 | `src/cdp.ts` | 无依赖的 headless Chrome 驱动（WebSocket） | `launchSession()`, `findBrowser()` |
| UI 检测 | `src/detector-ui.ts` | L3 文本判据、DOM 轮询 | `detectUi()`, `classifyDom()`, `FAILED_MARKER` |
| 状态存储 | `src/store.ts` | state.json 原子读写、快照管理、守卫锁 | `readState()`, `writeState()`, `acquireLock()` |
| 回滚引擎 | `src/rollback.ts` | 阈值判定、坏配置备份、防循环、成功记账 | `maybeRollback()`, `recordSuccess()` |
| 环境发现 | `src/env.ts` | dsh/browser/port 自动发现 + 启动前自检 | `preflight()`, `resolveCommand()` |
| 命令面 | `src/cli.ts` | 子命令解析 + 各命令处理器（status/backup/restore/reset/watch/dsh…） | `parseCli()` |
| 真实 DSH 上下文 | `src/dsh-context.ts` | 解析真实 DSH 安装（home/profile/checkout）+ 进程/插件连接状态 | `resolveDshContext()`, `findDshPackages()` |
| 交互控制台 | `src/console.ts` | 懒人脚本 CMD 菜单 GUI | `openConsole()` |
| 插件挂载 | `src/install-plugin.ts` | 把 dsh-qaq 插件装入 DSH profile（bundle 机制） | `installPlugin()` |
| 全屏仪表盘 | `src/tui.ts` | raw-mode TTY 仪表盘：实时状态、快捷键、语言切换 | `runTui()` |
| 安装 | `src/setup.ts` | 一条命令装依赖 + 构建 | `runSetup()` |
| 路径助手 | `src/paths.ts` | `$DSH_HOME` / `.qaq` / profile 路径推导 | `resolveDshHome()`, `qaqDir()`, `profileDir()` |
| 日志 | `src/log.ts` | 结构化多文件轮转日志 | `Logger` |
| 插件↔CLI 共享通道 | `src/shared-io.ts` | 插件与守卫之间的 JSON 心跳 / 健康状态 / `events.jsonl` | `readPluginHeartbeat()`, `pushEvent()` |
| 外部守卫接管 | `src/watch.ts` | `qaq watch`：监视并非 CLI 启动的 DSH（按心跳发现），计数 + 回滚 | `watchOnce()`, `resolveWatchTarget()` |
| 版本更新（Beta） | `src/update.ts` | 本地/远端版本解析比较、GitHub 检测、源码包下载 | `checkForUpdate()`, `downloadUpdateSource()`, `compareVersions()` |
| Webhook 投递 | `src/webhook.ts` | 无依赖的启动失败 / 回滚事件 POST 通知 | `deliverWebhooks()` |
| DSH 备份插件 | `packages/dsh-qaq/` | 在 DSH host 内部：真实用户对话后写 last-good 快照 + 持续向共享通道写心跳/清单/状态 | `apply()`, `isUserConversation()` |

---

## 3. 一次受监督启动的时序

```
用户（qaq console → [1]，或 qaq dsh web）
  │
  ▼
preflight()                     ── 环境自检（dsh 命令 / 浏览器 / 端口）
  │  fatal 错误 → 拒绝启动并给中文提示
  ▼
acquireLock(home)               ── PID 感知守卫锁（防双实例；陈旧锁自动回收）
  ▼
superviseBoot(GuardOptions)     ── 守卫编排（最多 retries+1 次尝试）
  │  ┌──────────────────────────────────────────┐
  │  │ bootAttempt():                           │
  │  │   spawnDsh → ready（端口就绪）→ detectUi │
  │  └──────────────────────────────────────────┘
  │  ├─ ok → confirmStable（稳定确认窗口 + 二次探测）→ recordSuccess → 交还子进程给调用方
  │  └─ 失败 → 分类 host / ui / unknown
  │         ├─ unknown：不计分，报告
  │         └─ host / ui：incrementFailure → 阈值判定 → maybeRollback
  ▼
verdict（BootHealthy | BootFailure）
  ├─ 健康：cli 保持子进程运行（可见窗口即 GUI），等待退出
  ├─ 回滚成功：再启动一次（防循环围栏内），健康则继续监督
  └─ 失败：给出 rolled-back 指引
```

---

## 4. 状态机（每个 profile）

```
               ┌──────────────┐
               │  健康（监督中）│◄────────────┐
               └──────┬───────┘             │
                  │ 确认窗口后           recordSuccess
                  │ recordSuccess       （清零计数 / 清围栏 / 写快照）
                  ▼                      │
           ┌──────────────┐              │
           │ 失败（计数 +1）│             │
           └──────┬───────┘              │
                  │                      │
        计数 < 阈值（默认3）             │
        或 无 last-good 快照             │
                  ▼                      │
           ┌──────────────┐   触发回滚   ┌──────────────┐
           │ 报告失败，退出 │───────────►│ 回滚 + 重启一次 │
           └──────────────┘  (或用户拒绝) └──────┬───────┘
                                                │ 重启仍失败且 5 分钟内
                                                ▼（防循环围栏生效）
                                          ┌──────────────┐
                                          │ 停止，指引手动修复 │
                                          └──────────────┘
```

---

## 5. 数据流（配置 → 快照 → 回滚）

```
$DSH_HOME/profiles/web/
  package.json        ── 声明 dsh.profile.bundles（插件层列表）
  cordis.patch.yml    ── 用户 patch 层（QAQ 从不修改）

         │ 健康确认后（守卫） / 真实用户对话后（dsh-qaq 插件）
         ▼
$DSH_HOME/.qaq/
  state.json          ── 计数 / lastSuccess / lastGoodSnapshot / rolledBackAt
  latest-good/        ── 最近一次确认健康的配置副本（package.json + cordis.patch.yml + manifest.json）
  history/auto/<ts>/  ── 自动备份（守卫确认健康 / 插件真实对话后；独立 10 份配额）
  history/manual/<ts>/── 手动备份（qaq backup / TUI `[3]`；独立 3 份配额）
  rolled-back/<ts>/   ── 回滚前保存的坏配置（人工恢复用）
  log/                ── qaq.log / error.log / access.log / host.log
  .guard.lock         ── PID 感知守卫锁

         │ 失败达到阈值
         ▼
maybeRollback → 备份坏配置到 rolled-back → 覆盖 profile 配置 → 重启
```

**快照原则**：只快照启动相关配置（`package.json` + `cordis.patch.yml`）。**绝不**纳入凭据、会话、storages、mcp-servers。

---

## 6. 关键设计决策

| 决策 | 理由 |
|------|------|
| 文本级 UI 判据（`Failed to load plugins` / `<textarea>`） | 红屏结构类是 CSS-Module hash，跨构建不稳定 |
| 无 Playwright/Puppeteer，手写 CDP | 运行时依赖仅 `ws` 一个，体积与可控性 |
| 原子写入（temp + rename） | 崩溃绝不留下半写 state/快照 |
| 瞬态重试（`retries=1`）且每次先杀子进程 | Windows 偶发 EBUSY 不算计数；失败启动不泄漏进程占端口 |
| 确认窗口二次探测 | 首检健康后立即劣化的启动绝不被记为 last-good |
| 回滚前 diff 预览 + Y/N | 用户知情，不背后回滚 |
| 回滚后 5 分钟防循环围栏 | 重启仍失败时不再自动连环重启 |
| install-plugin 只加 bundle 不碰 user patch | DSH 自动从 bundle 的 `dsh.bundle.patch` 加载插件层；user patch 再插行会 duplicate entry 崩溃 |

---

## 7. 目录结构

```
src/                        # 主程序（ESM，tsx 或 esbuild 打包 dist/qaq.mjs）
packages/dsh-qaq/           # DSH 备份插件（独立包，lib/index.js 为构建产物）
bin/                        # CLI 入口：qaq.cmd（纯 ASCII 开发包装）+ qaq.mjs（dist/tsx 引导）
qaq-test-plugins/           # 集成测试夹具（dsh-broken-theme → 确定性红屏）
tools/                      # smoke.mjs / rollback-test.ps1 / loop-test.ps1
test/                       # vitest 单测（27 个 spec 文件，270 个用例）
docs/                       # 本文档集合
```
