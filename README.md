# QAQ — DeepSeek Harness 启动容灾守卫

当 profile 配置损坏导致 DeepSeek Harness（下称 DSH）无法正常启动（宿主崩溃 **或** Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。

**不侵入 DSH 源码**：守卫是独立可执行，只通过 spawn 进程 + CDP 读浏览器真实 DOM；备份插件只读配置不改行为。

## 它解决什么

DSH Web 存在一种「宿主活、UI 红屏」的失败模式，宿主进程正常、端口可达，但浏览器渲染出 Failed to load plugins。这类失败纯监听宿主进程抓不到、纯 curl 抓空 root 也测不到，唯一可靠手段是用 headless Chrome 通过 CDP 读真实 DOM。QAQ 的 UI 侦测线正是这么做。

## 安装 / 快速上手

环境：Node >= 22。本仓库即项目根（与 DSH 安装/克隆相互独立）。

    pnpm install
    pnpm build          # 产出 dist/qaq.mjs 单文件可执行

从可见 CMD 窗口接管 dsh web：

    bin\qaq-web.cmd [--port 3080] [--yes]

或直接：

    qaq dsh web --port 3080 --yes

> 用哪个 dsh 启动？守卫默认执行 dsh web（PATH 解析）。指定自定义启动命令：
>     QAQ_DSH_CMD="node --import tsx/esm apps/cli/src/bin.ts web" qaq dsh web

## 命令面

| 命令 | 作用 |
|------|------|
| qaq dsh web [--port N] [--yes] | 接管启动：侦测 host/UI 失败 -> 计数 -> 触发时回滚 -> 重启（带防死循环） |
| qaq status | 显示 ~/.dsh/.qaq/state.json 摘要 |
| qaq backup [--profile web] | 手动快照当前 profile 为 last-good |
| qaq restore --to <snapDir> [--profile web] | 手动从某快照还原 profile |
| qaq reset --profile web | 清零失败计数 |

## 侦测判据（L3，实证）

- UI 失败：document.body.innerText 含固定文本 Failed to load plugins（稳定跨版本）；异常详情直接给出缺失插件/服务。
- 成功：出现 composer 业务容器（textarea）且无红屏文本，稳定 >= 20s。
- 不使用 CSS 类选择器：红屏结构类是 CSS Modules 哈希（跨构建不稳定）。

## 状态与存储（~/.dsh/.qaq/）

- state.json：hostFailures / uiFailures / lastSuccess / lastFailure / lastGoodSnapshot / rolledBackAt
- latest-good/：当前「确认成功」的 profile 配置副本（package.json + cordis.patch.yml + manifest）
- history/<ts>/：最近 5 份历史快照
- rolled-back/<ts>/：被执行回滚的坏配置（手动还原用）
- log/qaq.log

**绝不纳入快照**：凭据、会话、storages、mcp-servers。

## 触发与防死循环

- 连续 3 次同类（host 或 ui）失败 -> 触发回滚。
- 默认需用户在窗口确认（Y/N），--yes 全自动。
- 回滚后进入 5 分钟防死循环栅栏：窗口内再次失败即停手，指引人工检查 rolled-back/。

## 里程碑对照

| 里程碑 | 状态 |
|--------|------|
| M1 仓库初始化 + 接管 spawn | ok |
| M2 host 失败侦测 + state 计数 | ok |
| M3 L3 CDP 文本侦测 | ok（复现红屏样本实测） |
| M4 成功快照 + 成功判定 | ok |
| M5 回滚 + 坏版备份 + 确认 + 防死循环 | ok |
| M6 命令面 + 日志 + 测试 | ok（vitest 16 通过） |

## 测试

    pnpm test        # vitest 单元测试（store / rollback / detector-ui 判据）

集成验收素材：qaq-test-plugins/dsh-broken-theme（注入永不存在的服务 -> 确定性红屏），配合 tools/rollback-test.ps1 可在完整 DSH 实例上跑通「失败->计数->回滚->还原」闭环。

## 开发布局

    src/
      cli.ts            命令面 + 接管循环
      guard.ts          superviseBoot 编排（host 就绪 -> UI 侦测 -> 计数/回滚）
      spawn-dsh.ts      spawn dsh web、继承 env、就绪/退出监听
      cdp.ts            极简 CDP 客户端（headless Chrome，无 Playwright）
      detector-ui.ts    L3 文本判据
      store.ts          ~/.dsh/.qaq 原子读写 + 快照管理 + 锁
      rollback.ts       回滚 + 坏版备份 + 防死循环 + 成功记账
      paths.ts / log.ts
    packages/dsh-qaq/   DSH 备份插件（boot settle 后写快照，仅备份不改行为）
    tools/  bin/  test/

## 说明

- 仓库与 DSH 解耦；守卫仅有 ws 一个运行时依赖，可 esbuild 打成单文件。
- 设计依据与复现实验见 QAQ计划定案.md。
