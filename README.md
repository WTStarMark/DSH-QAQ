# QAQ — DeepSeek Harness 启动容灾守卫

[English](./README.EN.md)

当 profile 配置损坏导致 DeepSeek Harness（下称 DSH）无法正常启动（宿主崩溃 **或** Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。

**作者**：WTStarMark

**不侵入 DSH 源码**：守卫是独立可执行，只通过 `spawn` 进程 + CDP 读浏览器真实 DOM；备份插件只读配置不改行为。

<p align="center">
  <img src="img/zh.png" alt="QAQ 界面展示" width="49%" />
  <img src="img/en.png" alt="QAQ interface" width="49%" />
</p>

## 它解决什么

DSH Web 存在一种「宿主活、UI 红屏」的失败模式：宿主进程正常、端口可达，但浏览器渲染出 `Failed to load plugins`。这类失败纯监听宿主进程抓不到、纯 `curl` 抓空 root 也测不到（服务端 HTML 里 `<div id="root">` 是空的，由 React 运行时渲染）。唯一可靠且不侵入的手段，是用 headless 浏览器打开页面、读取真实 DOM。QAQ 的 UI 侦测线正是这么做。

## 环境要求

- Node.js >= 22
- 机器上有 Chrome/Chromium/Edge（经 CDP 无头驱动；无 Playwright/Puppeteer 依赖）
- `dsh` 在 `PATH`，或用 `QAQ_DSH_CMD` / `--cwd` 指定 DSH 启动命令与工作目录

## 安装 / 快速上手

**一条命令**：`qaq setup` 安装依赖并构建，然后 `qaq tui` 打开全屏实时守卫仪表盘。

手动安装：

```bash
pnpm install
pnpm build   # 产出 dist/qaq.mjs 单文件可执行
```

**日常使用推荐 `qaq tui`**（全屏实时仪表盘，全能入口：一键启动守卫、浏览日志、管理插件、热更新、侧载 watch 都在里面）：

```bash
qaq tui --port 3080
```

> 不想用仪表盘时，也可以直接单次受监督启动：

```bash
qaq dsh web --port 3080 --yes
```

> **用哪个 dsh 启动？** 守卫默认执行 `dsh web`（PATH 解析）。若要从 DSH 源码树启动：
>
> ```bash
> QAQ_DSH_CMD="node --import tsx/esm apps/cli/src/bin.ts web" qaq dsh web --cwd /path/to/dsh-checkout
> ```

> **启动前自检**：`qaq dsh web`（和控制台）会自动发现 `dsh` 命令——`QAQ_DSH_CMD` → `--cwd` → 就近的 DSH checkout（当前目录的祖先链，以及**与当前目录并排的兄弟 checkout**，如 QAQ 与 `deepseek-harness` 同目录并列）→ `PATH`——挑选 Chrome/Chromium/Edge 作为 UI 探测浏览器、确认目标端口空闲。发现问题会在拉起任何进程前给出中文可操作提示。

## 命令面

| 命令                                         | 作用                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `qaq dsh web [--port N] [--yes]`             | 接管启动：侦测 host/UI 失败 -> 计数 -> 触发时回滚 -> 重启（带防死循环） |
| `qaq status`                                 | 显示 `~/.dsh/.qaq/state.json` 摘要                                      |
| `qaq backup [--profile web]`                 | 手动快照当前 profile 进「手动备份」集（独立保留 3 份）                                |
| `qaq restore --to <snapDir> [--profile web]` | 手动从某快照还原 profile（自动/手动集皆可）                                     |
| `qaq reset --profile web`                    | 清零失败计数                                                            |
| `qaq tui` / `qaq console`                    | 打开全屏实时仪表盘（非 TTY 时退回简洁菜单）                             |
| `qaq setup`                                  | 一条命令安装依赖 + 构建                                                 |
| `qaq install-plugin [--profile web]`         | 自动把 dsh-qaq 备份插件挂载进 profile                                   |

全局开关：`--yes` 自动确认回滚。

## 仪表盘（`qaq tui` / `qaq console`）

在终端（`qaq tui`）下 QAQ 显示**全屏、自动刷新**的仪表盘——TUI 是**全能入口**：既能启动守卫（启动器模式），也能附着到外部启动的 DSH（侧载模式），还能浏览日志、管理插件。面板显示守卫状态、当前运行模式（启动器 / 侧载 / 空闲）、失败计数、last-good 快照、插件挂载状态、**日志查看器**和**插件管理器**。非 TTY 时退回一次性屏幕菜单（`qaq console`）。界面**双语**——在 TUI 内按 `10` 切换 en/zh（裸 `qaq console` 默认中文；`$QAQ_LANG` 或 `--lang` 可覆盖）。可用操作：

```
[1] 一键启动守卫（接管 dsh web）     — 启动器模式：每次自检，回滚 + 重启
[2] 刷新状态面板                     — 同时约每 1 秒自动刷新
[3] 手动备份当前配置（进「手动备份」集）
[4] 备份/回滚列表                 — 打开备份管理子屏：分「自动备份」与「手动备份」两群，选一项还原
[5] 重置失败计数
[6] 挂载 dsh-qaq 备份插件             — 幂等、失败即撤销
[7] 管理插件                         — 安装 / 卸载 / 停用 / 启用
[8] 查看日志                         — 全屏日志查看器（error/access/host/qaq）
[9] 侧载 watch                       — 对外部启动的 DSH 运行持续侧载守卫（开关切换）
[10] 热更新                          — client 插件热更监控 + bundle/dist 自动重启开关
[11] 切换语言 en / zh
[12] 退出
```

导航：`↑`/`↓`（或 `j`/`k`）移动选择，`Enter`/`Space` 执行，数字 `1..N` 直达动作，`q`/`Esc`/`Ctrl+C` 退出。

- **日志查看器**（`[8]`）：`1`–`4` 切换 `error.log` / `access.log` / `host.log` / `qaq.log`，`↑`/`↓` 滚动，`q`/`Esc`/`Enter` 返回菜单。
- **插件管理器**（`[7]`）：管理**真实的 DeepSeek Harness** 插件。它自动发现 DSH 安装（home + 源码 checkout，并通过心跳检测正在运行的进程），扫描 checkout 的 `packages/` 找到可安装的 `@deepseek-ai/dsh-*` bundle 包，列出当前 profile 里已安装/已启用的项；`↑`/`↓` 选中插件，然后 `e` 启用、`d` 停用、`u` 卸载、`i` 安装；`q`/`Esc` 返回菜单。**停用** = 保留模块但移出启动 bundle；**卸载** = 两者都移除。它绝不改动 QAQ 自己的仓库。
- **dsh-qaq 插件**：**TUI 打开时自动挂载**——若 profile 未安装/未启用 dsh-qaq，QAQ 自动完成挂载（写入 bundle 列表 + 建立模块链接），已安装启用的不受打扰（best-effort，失败仅告警）。菜单 `[6]` 是可随时重跑的**覆盖更新入口**：校验模块链接目标，指向过期/失效 QAQ 副本（junction 目标校验、孤儿链接、重建 lib）时自动修复——旧链接绝不会静默加载旧插件代码；真实目录/文件占位则拒绝替换（保护用户数据）。
- **备份管理**（`[4]`）：备份列表子屏，明确区分**自动备份**与**手动备份**两群——自动备份（守卫确认健康 / 插件真实对话后自动产生，独立保留 **10** 份）与手动备份（`[3]` 或 `qaq backup` 产生，独立保留 **3** 份）互不干扰。`↑`/`↓` 移动选择、`Enter` 还原到该项、`q`/`Esc` 返回。
- **运行模式**：状态行显示当前集成模式 —— **启动器**（QAQ 拥有被监督的 `dsh web`）、**侧载**（检测到外部 DSH，或在持续监视它）、或**空闲**。
- **侧载守卫**（`[9]`）：一个**开关**。首次按下会先解析外部 DSH 目标（`qaq tui --port` 指定的端口，否则用 dsh-qaq 插件心跳），固定该端口后每隔约 15s 探测一次真实 DOM——计数 host/UI 失败并在达到阈值时回滚（自动确认、CLI 决策），与 `qaq watch` 行为一致。再按 `[9]`（或退出仪表盘）即停止。状态行会显示被监视的 URL 与最近一次探测结果。
- **热更新**（`[10]`）：插件热更新的三通道开关面板，全部**默认关闭**、可选启用：
  - `[1]` **client bundle 热更监控**——监视每个已启用 client 插件的 `lib/client.js`（DSH 的 client-hmr 会热换浏览器 fiber，无需重启）。QAQ 负责**验证**（CDP 全新页面探测 + dsh-qaq 插件清单）与**回滚**：热换前把旧 bundle 快照进 `~/.dsh/.qaq/hot-snapshots/`，验证失败时还原文件（再次触发热换回旧码）并复核，仍失败才升级到受监督重启。**它只读 `.qaq` 与 profile 文件，绝不触碰 state.json / last-good / 失败计数 / 防循环栅栏**。
  - `[2]` **bundle 列表变化自动重启**——profile `package.json` 的 `dsh.profile.bundles` 变化（增删插件）需要重启才生效；开启后守卫检测到变化会自动执行**受监督重启**（kill → 重新 boot → 健康确认窗口，失败走既有回滚），即"伪更新"。需先按 `[1]` 进入启动器模式。
  - `[3]` **web dist 变化自动重启**——DSH 前端 `apps/web/dist`（或已安装的 `dsh-web-frontend/dist`）重建后无法热换，开启后同样触发受监督重启。
  - 插件管理器（`[7]`）里对 **client 类插件**的启用/停用走 `cordis.patch.yml`，DSH 的配置 HMR 会**即时生效**——QAQ 会轮询插件清单确认已生效（`已热生效 ✔`）；DSH 离线时提示"重启后生效"；失败时提示"旧树仍在运行"（DSH HMR 失败保留 last-good 树，与守卫"失败不破坏"哲学一致）。**bundle 类插件**的变更仍标记"重启后生效"，可配合 `[2]` 自动重启。

受监督的 `dsh web` 运行期间，守卫锁会一直持有到它退出（期间拒绝二次启动，也不会被过期的端口检查误导）；`q`/`Esc`/`Ctrl+C` 退出仪表盘时会先杀掉受监督子进程，避免进程残留占住端口。

控制台在每次渲染菜单前自动清屏——窗口永远只保留一屏内容（持久头部 + 上次操作结果 + 菜单），不再堆叠；状态/日志等详情视图会以 `[回车返回菜单]` 暂停，方便阅读。

## 操作指南

### 首次配置（Windows）

1. **安装** — 运行 `qaq setup`。它会检查 Node.js >= 22、安装依赖（pnpm，失败时回退 npx）、并构建 `dist/qaq.mjs`。
2. **挂载备份插件（推荐）** — 打开 `qaq tui`（仪表盘打开时会自动挂载 dsh-qaq；若需手动重挂/覆盖更新，用菜单 `[6]`）。它把 `dsh-qaq` 加进 profile 的 bundle 列表，并在 profile 的 `node_modules` 里建好模块链接。此后插件会在**一次真实用户对话**发生后自动把配置快照到 `~/.dsh/.qaq`——因为只有人类真的发过消息才能证明这套配置可用（宿主 settle 但 Web UI 红屏的坏配置永远不会被记为 good，见下方"可疑 last-good"）。仅备份、绝不改 DSH 行为。profile 自己的 `cordis.patch.yml` 故意不动——DSH 会从 bundle 声明自动加载插件的 patch 层。
3. **启动** — 在 TUI 菜单按 `1` 一键启动守卫。仪表盘会重新做启动前自检（dsh 命令、浏览器、端口），然后接管 `dsh web`。UI 稳定通过确认窗口后，配置被记为 last-good，守卫转入后台持续监控（随时可退出菜单，守卫继续运行）。
4. **验证** — `qaq status`：`hostFailures` / `uiFailures` 应为 0，且存在 `lastSuccess` / `lastGoodSnapshot`。

### 日常使用

- 每次都用同一方式启动 DSH：`qaq tui` → 按 `1`。之后尽量不要再直接跑 `dsh web`——守卫是唯一能发现红屏的监督者。
- 若 UI 连续红屏（或宿主崩溃）**3 次**，QAQ 会给出回滚确认（带 diff 预览）。接受即可——坏配置会保留在 `~/.dsh/.qaq/rolled-back/` 供事后检查，守卫会自动重启一次。
- 回滚 + 重启成功后，失败计数清零、防死循环栅栏解除；恢复的配置就是坏掉之前的那份。

### 故障排查

| 现象                             | 处理方法                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `启动前自检未通过`（找不到 dsh） | 把 `dsh` 加进 `PATH`、设置 `QAQ_DSH_CMD`，或用 `--cwd <dir>` 指向 DSH 源码目录                                                                       |
| `端口已被占用`                   | 停掉占用进程，或用 `--port N` 换端口                                                                                                                 |
| 回滚后 UI 仍然红屏               | 看日志与保留的坏配置：`qaq tui`（仪表盘内直接看日志），或直接读 `~/.dsh/.qaq/log/`（`error.log` / `access.log` / `host.log`）                        |
| 提示 `anti-loop fence is active` | 5 分钟内已发生过回滚。先手动修复配置（见 `rolled-back/`），再 `qaq reset --profile web` 清计数                                                       |
| 想撤销一次回滚                   | `qaq restore --to <snapDir> --profile web`，`snapDir` 用 `~/.dsh/.qaq/history/auto/`（或 `history/manual/`、`rolled-back/`）下任意目录                                       |
| dsh-qaq 不写快照                 | 插件只在**真实用户对话发生后**写 last-good——宿主 settle 但 UI 红屏、或一直无人对话都不写。确认 profile 已含 `dsh-qaq` bundle（`qaq console` → **[2]** 能看到最近快照）且 `install-plugin` 报成功 |

### 数据位置

- 守卫状态、快照、日志：`~/.dsh/.qaq/`（或 `$DSH_HOME/.qaq/`）
- profile 配置：`$DSH_HOME/profiles/<name>/`（`package.json` + `cordis.patch.yml`）
- `qaq status` 会打印你环境下的确切路径。

## `qaq dsh web` 调优参数

| 参数                | 含义                                                   | 默认       |
| ------------------- | ------------------------------------------------------ | ---------- |
| `--confirm-ms <ms>` | 稳定健康确认窗口（成功判定前的观察时长）               | `20000`    |
| `--ui-timeout <ms>` | L3 UI 侦测最长等待                                     | `25000`    |
| `--threshold <n>`   | 触发回滚的连续同类失败数                               | `3`        |
| `--cwd <dir>`       | 被监督 `dsh` 的工作目录（源码启动时指向 DSH checkout） | 本进程 cwd |

## 侦测判据（L3，实证）

- **UI 失败**：`document.body.innerText` 含固定文本 `Failed to load plugins`（跨构建稳定）；异常详情直接给出缺失插件/服务（如 `web boot: 1 entry did not activate dsh-x: pending (waiting for service: s)`）。
- **成功**：出现 composer 业务容器（`<textarea>`）且无红屏文本，稳定 >= `--confirm-ms`。
- **不使用 CSS 类选择器**：红屏结构类是 CSS Modules 哈希（`_boot_<hash>`），跨构建不稳定。

## 状态与存储（`~/.dsh/.qaq/`）

- `state.json` — `hostFailures` / `uiFailures` / `lastSuccess` / `lastFailure` / `lastGoodSnapshot` / `rolledBackAt`
- `latest-good/` — 当前「确认成功」的 profile 配置副本（package.json + cordis.patch.yml + manifest）
- `history/auto/<ts>/` — 自动备份集（守卫确认健康 / 插件真实对话后写入，独立保留 10 份）
- `history/manual/<ts>/` — 手动备份集（`qaq backup` / TUI `[3]` 写入，独立保留 3 份）
- `rolled-back/<ts>/` — 被执行回滚的坏配置（手动还原用）
- `log/` — 结构化多文件日志（见下）

**绝不纳入快照**：凭据、会话、storages、mcp-servers。

## 日志（供开发者检修）

每条记录一行 JSON（`{ ts, level, cat, phase?, msg, ...meta }`），可机器解析；按 `log/` 下四个文件分门别类，各自按大小轮转（256 KB → `.1.log`，保留 5 份）：

| 文件         | 内容                                                         |
| ------------ | ------------------------------------------------------------ |
| `qaq.log`    | 全部（info + warn + error），主记录                          |
| `error.log`  | 仅 warn/error——快速 grep 问题                                |
| `access.log` | 崩溃审计轨迹：启动结论、快照、回滚、重置、插件挂载、手动还原 |
| `host.log`   | 被监督 `dsh` 的原始 stdout/stderr（同时镜像到可见窗口）      |

## 触发与防死循环

- 连续 **3** 次同类（host 或 ui）失败 -> 触发回滚。
- **例外——确定性宿主崩溃**：子进程死亡且输出带启动失败标记（`plugin tree failed to load` 等）属于确定的配置错误，**首次命中即回滚**（有效阈值 1，不再等 3 次），无需重复手动启动。防死循环栅栏与 Y/N 确认（除非 `--yes`）仍然生效。
- 默认需用户在窗口确认（Y/N）；`--yes` 全自动。
- **拒绝确认即停手，不自动重启**：坏配置保留原位（同时备份到 `rolled-back/`）供手动还原——守卫绝不会在你背后用 autoConfirm 重启来强行回滚。
- 回滚后进入 **5 分钟防死循环栅栏**：窗口内再次失败即停手，指引人工检查 `rolled-back/`。

## 可靠性增强

- **瞬态失败重试**（`retries=1`）：对疑似瞬时错误（host 未就绪 / bundle 脚本加载失败）自动重试一次，不计入失败计数，避免 Windows 偶发 EBUSY 误伤。**带失败标记的确定性宿主崩溃不重试**（重试只会复现同样的错误），直接计数并首次即回滚。每次重试前会先杀掉上一次的子进程——失败启动绝不会泄漏进程占住端口或挂住守卫。
- **确认窗口复查**：首次健康 DOM 探测后，启动需稳定经过 `--confirm-ms`，随后再对真实 DOM 复查一次才写 last-good 快照——首次健康后立即劣化的启动绝不会被记为 good。
- **PID 感知守卫锁**：崩溃残留的陈旧锁在下一次运行自动回收，避免「假占用」。
- **回滚 diff 预览**：Y/N 确认前打印当前配置与 last-good 的差异。
- **历史保留确定性**：快照按 ISO 时间戳名排序，跨重启保留稳定。
- **宿主失败快速上报**：子进程在端口打开前退出（或 spawn 失败，如命令不存在）会立即上报，不再干等完整端口超时。

## 守卫能力与边界

**能守卫的（按代码事实）：**

| 类别 | 机制 |
|---|---|
| 启动失败（host） | 端口未就绪 / 进程早退 / fail-loud 标记（`plugin tree failed to load` 等）→ 确定性错误**首次即回滚** |
| UI 红屏 | 固定文本 `Failed to load plugins`；确定性红屏（`did not activate … waiting for service`）首次即回滚 |
| 运行中劣化 | 确认窗口复查 + 侧载每 15s 重探测真实 DOM |
| 环境/依赖类失败 | 输出含 `EPERM` / `ERR_MODULE_NOT_FOUND` / `unsupported engine` 等 → 归为 `env`，**不计数、不回滚**（回滚无效），提示检查 DSH 安装 / Node 版本 / 权限 |
| 快照损坏 | 回滚前校验快照（JSON 可解析、`bundles` 结构合法、patch 非空）——坏快照绝不还原；状态指针损坏时自动回退到**最新合法**自动快照 |
| 非红屏劣化信号 | 已启用插件 fiber 落入 `failed` 态（dsh-qaq 清单）或探测期捕获 console error → 告警 + `ui-degraded` 事件（**不计分**，避免误杀次要插件） |

**仍无法守卫的（设计盲区，需人工）：**

- **非红屏语义损坏**：页面渲染健康但功能逻辑损坏（按钮无响应、运算错误）——DOM 探测与 fiber 信号都看不到语义。
- **UI 卡死无响应**：探测超时归 `unknown`，**不计数**（慢加载与真卡死难以区分，宁可漏报）。
- **非配置根源**：DSH 自身 bug、依赖损坏、磁盘满等——能检测会重试，但回滚无效（`env` 类已单独分类提示）。
- **Electron/桌面载体**：守卫的 UI 探测针对 `dsh web` 的 HTTP 页面。
- **用户浏览器独有环境**：守卫用自己的 headless Chrome 探测，用户浏览器缓存/扩展问题不可见。
- **侧载发现依赖心跳**：`qaq watch` 靠 dsh-qaq 心跳发现目标端口，插件未装则发现不了。

## 测试

```bash
pnpm test      # vitest 单元测试（store / paths / cli / dsh-context / rollback / detector-ui / guard / spawn-dsh / env / install-plugin / tui / watch / webhook / cdp / log / i18n / …）
pnpm smoke     # 一键回归：单测 + 隔离 home 种子/破坏/守卫检测
```

`pnpm smoke` 在可用 DSH checkout（`QAQ_SMOKE_DSH_HOME`）时才会执行真实 DSH 集成段。

CI（`.github/workflows/ci.yml`）在 **ubuntu-latest** 与 **windows-latest** × **Node 22 / 24**、冻结 lockfile 下运行 typecheck + 风格检查 + 构建 + 插件 lib 一致性 + 单测 + smoke。

集成验收素材：`qaq-test-plugins/dsh-broken-theme`（注入永不存在的服务 -> 确定性红屏），配合 `tools/rollback-test.ps1` 可在真实 DSH 实例上跑通「失败 -> 计数 -> 回滚 -> 还原」闭环。

## 仓库布局

| 路径                          | 作用                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `src/cli.ts`                  | 命令面 + 接管循环                                                                       |
| `src/guard.ts`                | superviseBoot 编排（host 就绪 -> UI 侦测 -> 计数/回滚）                                 |
| `src/spawn-dsh.ts`            | spawn dsh web、继承 env、就绪/退出监听                                                  |
| `src/cdp.ts`                  | 极简 CDP 客户端（headless Chrome，无 Playwright）                                       |
| `src/detector-ui.ts`          | L3 文本判据                                                                             |
| `src/store.ts`                | `~/.dsh/.qaq` 原子读写 + 快照管理 + 锁                                                  |
| `src/rollback.ts`             | 回滚 + 坏版备份 + 防死循环 + 成功记账                                                   |
| `src/env.ts`                  | 环境自动发现 + 启动前自检（dsh / 浏览器 / 端口）                                        |
| `src/console.ts`              | 交互式菜单 GUI（懒人脚本，CMD 窗口）                                                    |
| `src/install-plugin.ts`       | 自动挂载 dsh-qaq 备份插件（失败即撤销，绝不弄坏启动）                                   |
| `src/paths.ts` · `src/log.ts` | 路径助手；结构化多文件轮转日志                                                          |
| `src/shared-io.ts`            | 插件↔CLI 通道：心跳 / 健康状态 / `events.jsonl`                                         |
| `src/watch.ts`                | `qaq watch`：为任何方式启动的 DSH 附设守卫（按插件心跳发现）                            |
| `src/webhook.ts`              | 无依赖的启动失败 / 回滚事件 POST 通知                                                   |
| `packages/dsh-qaq/`           | DSH 备份插件（真实对话后写自动备份 + 心跳；仅备份；`lib/` 由 `pnpm build` 生成）             |
| `bin/`                        | `qaq.cmd` + `qaq.mjs` —— 唯一通用 CLI 入口（`qaq setup` / `qaq tui` / `qaq dsh web` …） |
| `tools/` · `test/`            | 集成/smoke 脚本；vitest 测试                                                            |

## 文档

面向二次开发的专项解析文档：

| 文档                                                      | 内容                                             |
| --------------------------------------------------------- | ------------------------------------------------ |
| [architecture.zh.md](docs/architecture.zh.md)             | 架构总览：模块地图、启动时序、状态机、数据流     |
| [guard-lifecycle.zh.md](docs/guard-lifecycle.zh.md)       | 守卫生命周期：失败分类、瞬态重试、确认窗口       |
| [state-and-rollback.zh.md](docs/state-and-rollback.zh.md) | 状态存储与回滚：state.json、快照、防循环、守卫锁 |
| [ui-detection.zh.md](docs/ui-detection.zh.md)             | UI 检测与 CDP：无依赖客户端、L3 判据、探测时序   |
| [console-and-env.zh.md](docs/console-and-env.zh.md)       | 懒人脚本控制台与环境自动发现、插件挂载           |
| [logging.zh.md](docs/logging.zh.md)                       | 日志系统：结构化格式、四通道、轮转               |
| [testing.zh.md](docs/testing.zh.md)                       | 测试与真实集成：单测矩阵、smoke、故障注入        |

> 英文版见 `docs/*.md`（默认命名）。

变更日志：[Changelog.zh.md](Changelog.zh.md)（英文版 [Changelog.md](Changelog.md)）——按 git 历史梳理，覆盖「新增 / 修复 / 变更 / 移除」。

## 参与贡献

欢迎一切形式的贡献——Bug 报告、功能建议与 Pull Request 都能让 QAQ 变得更好。

**报 Bug / 提需求**：在 [Issues](https://github.com/WTStarMark/QAQ/issues) 提交，附上复现步骤（`~/.dsh/.qaq/log/access.log` 与 `error.log` 的关键片段最有帮助）和你的环境（操作系统、Node 版本）。

**提交 Pull Request**：

1. Fork 本仓库并创建功能分支。
2. 本地准备：`pnpm install`（Node 22+、pnpm 11——见 `.nvmrc`）。
3. 修改并**补测试**——见 [testing.zh.md](docs/testing.zh.md) 了解各 spec 覆盖点与新增用例的方式。
4. 通过门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`（CI 会在 Ubuntu 与 Windows 上强制执行）。
5. 开 PR，附上简短说明：改了什么、为什么。

入门指引：先读 [architecture.zh.md](docs/architecture.zh.md)，再深入 `docs/` 下各专项文档。

## License

MIT
