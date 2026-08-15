# QAQ — DeepSeek Harness 启动容灾守卫

[English](./README.md)

当 profile 配置损坏导致 DeepSeek Harness（下称 DSH）无法正常启动（宿主崩溃 **或** Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。

**不侵入 DSH 源码**：守卫是独立可执行，只通过 `spawn` 进程 + CDP 读浏览器真实 DOM；备份插件只读配置不改行为。

## 它解决什么

DSH Web 存在一种「宿主活、UI 红屏」的失败模式：宿主进程正常、端口可达，但浏览器渲染出 `Failed to load plugins`。这类失败纯监听宿主进程抓不到、纯 `curl` 抓空 root 也测不到（服务端 HTML 里 `<div id="root">` 是空的，由 React 运行时渲染）。唯一可靠且不侵入的手段，是用 headless 浏览器打开页面、读取真实 DOM。QAQ 的 UI 侦测线正是这么做。

## 环境要求

- Node.js >= 22
- 机器上有 Chrome/Chromium/Edge（经 CDP 无头驱动；无 Playwright/Puppeteer 依赖）
- `dsh` 在 `PATH`，或用 `QAQ_DSH_CMD` / `--cwd` 指定 DSH 启动命令与工作目录

## 安装 / 快速上手

```bash
pnpm install
pnpm build   # 产出 dist/qaq.mjs 单文件可执行
```

从可见 CMD 窗口接管 `dsh web`：

```cmd
bin\qaq-web.cmd [--port 3080] [--yes]
```

或直接：

```bash
qaq dsh web --port 3080 --yes
```

> **用哪个 dsh 启动？** 守卫默认执行 `dsh web`（PATH 解析）。若要从 DSH 源码树启动：
> ```bash
> QAQ_DSH_CMD="node --import tsx/esm apps/cli/src/bin.ts web" qaq dsh web --cwd /path/to/dsh-checkout
> ```

## 命令面

| 命令 | 作用 |
|------|------|
| `qaq dsh web [--port N] [--yes]` | 接管启动：侦测 host/UI 失败 -> 计数 -> 触发时回滚 -> 重启（带防死循环） |
| `qaq status` | 显示 `~/.dsh/.qaq/state.json` 摘要 |
| `qaq backup [--profile web]` | 手动快照当前 profile 为 last-good |
| `qaq restore --to <snapDir> [--profile web]` | 手动从某快照还原 profile |
| `qaq reset --profile web` | 清零失败计数 |

全局开关：`--yes` 自动确认回滚。

## `qaq dsh web` 调优参数

| 参数 | 含义 | 默认 |
|------|------|------|
| `--confirm-ms <ms>` | 稳定健康确认窗口（成功判定前的观察时长） | `20000` |
| `--ui-timeout <ms>` | L3 UI 侦测最长等待 | `25000` |
| `--threshold <n>` | 触发回滚的连续同类失败数 | `3` |
| `--cwd <dir>` | 被监督 `dsh` 的工作目录（源码启动时指向 DSH checkout） | 本进程 cwd |

## 侦测判据（L3，实证）

- **UI 失败**：`document.body.innerText` 含固定文本 `Failed to load plugins`（跨构建稳定）；异常详情直接给出缺失插件/服务（如 `web boot: 1 entry did not activate dsh-x: pending (waiting for service: s)`）。
- **成功**：出现 composer 业务容器（`<textarea>`）且无红屏文本，稳定 >= `--confirm-ms`。
- **不使用 CSS 类选择器**：红屏结构类是 CSS Modules 哈希（`_boot_<hash>`），跨构建不稳定。

## 状态与存储（`~/.dsh/.qaq/`）

- `state.json` — `hostFailures` / `uiFailures` / `lastSuccess` / `lastFailure` / `lastGoodSnapshot` / `rolledBackAt`
- `latest-good/` — 当前「确认成功」的 profile 配置副本（package.json + cordis.patch.yml + manifest）
- `history/<ts>/` — 最近 5 份时间戳历史快照
- `rolled-back/<ts>/` — 被执行回滚的坏配置（手动还原用）
- `log/qaq.log`

**绝不纳入快照**：凭据、会话、storages、mcp-servers。

## 触发与防死循环

- 连续 **3** 次同类（host 或 ui）失败 -> 触发回滚。
- 默认需用户在窗口确认（Y/N）；`--yes` 全自动。
- 回滚后进入 **5 分钟防死循环栅栏**：窗口内再次失败即停手，指引人工检查 `rolled-back/`。

## 可靠性增强

- **瞬态失败重试**（`retries=1`）：对疑似瞬时错误（host 未就绪 / bundle 脚本加载失败）自动重试一次，不计入失败计数，避免 Windows 偶发 EBUSY 误伤。
- **PID 感知守卫锁**：崩溃残留的陈旧锁在下一次运行自动回收，避免「假占用」。
- **回滚 diff 预览**：Y/N 确认前打印当前配置与 last-good 的差异。
- **历史保留确定性**：快照按 ISO 时间戳名排序，跨重启保留稳定。

## 测试

```bash
pnpm test      # vitest 单元测试（store / rollback / detector-ui 判据）
pnpm smoke     # 一键回归：单测 + 隔离 home 种子/破坏/守卫检测
```

`pnpm smoke` 在可用 DSH checkout（`QAQ_SMOKE_DSH_HOME`）时才会执行真实 DSH 集成段。

集成验收素材：`qaq-test-plugins/dsh-broken-theme`（注入永不存在的服务 -> 确定性红屏），配合 `tools/rollback-test.ps1` 可在真实 DSH 实例上跑通「失败 -> 计数 -> 回滚 -> 还原」闭环。

## 仓库布局

```
src/
  cli.ts            命令面 + 接管循环
  guard.ts          superviseBoot 编排（host 就绪 -> UI 侦测 -> 计数/回滚）
  spawn-dsh.ts      spawn dsh web、继承 env、就绪/退出监听
  cdp.ts            极简 CDP 客户端（headless Chrome，无 Playwright）
  detector-ui.ts    L3 文本判据
  store.ts          ~/.dsh/.qaq 原子读写 + 快照管理 + 锁
  rollback.ts       回滚 + 坏版备份 + 防死循环 + 成功记账
  paths.ts / log.ts
packages/dsh-qaq/  DSH 备份插件（host boot settle 后写快照，仅备份不改行为）
bin/               qaq / qaq-web.cmd 启动入口
tools/  test/  docs/
```

## 文档

- 设计依据与复现实验：`docs/QAQ计划定案.md`（另有草案/定稿）。

## License

MIT
