# 懒人脚本控制台与环境发现（console.ts / env.ts / install-plugin.ts / bin/）

本文件解析面向用户的懒人脚本层：环境自动发现与启动前自检、交互式 CMD 菜单、备份插件自动挂载，以及 `.cmd` 启动器的实现注意点。

相关文档：[架构总览](architecture.zh.md) · [守卫生命周期](guard-lifecycle.zh.md)

---

## 1. 环境自动发现（src/env.ts）

### 1.1 dsh 命令解析（`resolveCommand`）——优先级

```
1. $QAQ_DSH_CMD                 → 直接用拆分后的命令（相对路径需配合 --cwd 落在 checkout）
2. --cwd <dir>                  → 目录含 apps/cli → ['node','--import','tsx/esm',<cli>,'web']
3. findAutoCheckout() 自动扫描   → 见下
4. PATH 上的 dsh 可执行文件      → [<exe>,'web']；找不到则 source='none'（预检报错）
```

### 1.2 `findAutoCheckout` 扫描范围

1. **祖先链**：从 `process.cwd()` 向上最多 5 级，检查 `apps/cli/src/bin.ts` / `index.ts` / `dist/index.js`。
2. **兄弟目录**（懒人脚本场景关键）：扫描 cwd 父目录下的**所有直接子目录**，任一含 `apps/cli` 即命中——
   覆盖"QAQ 与 deepseek-harness 并排"的典型布局（从 QAQ 目录内启动 CLI，checkout 在兄弟目录）。

> PATH 分隔符按平台选择：Windows `;`，POSIX `:`（驱动器盘符 `C:\` 不能用 `/[;:]/` 一刀切）。

### 1.3 `preflight` 启动前自检

| 检查 | 级别 | 失败提示（中文） |
|------|------|------------------|
| dsh 命令存在（source != 'none'） | error | 找不到 dsh / 未发现源码目录 → 装 dsh / --cwd / QAQ_DSH_CMD |
| Chrome/Chromium/Edge 存在 | error | 装 Chrome 或 Edge（UI 检测必需） |
| 端口空闲（`isPortFree`，2.5s 超时） | error | 端口被占 → 先停旧进程或 --port 换端口 |
| checkout 不完整（有 checkout 但无 CLI 入口） | warn | 提示依赖/结构可能不完整 |

`preflight` 返回 `EnvReport`（command/cwd/home/browser/port/problems），`cli.ts` 只对 `error` 级 fatal。

---

## 2. 交互式控制台（src/console.ts）

### 2.1 菜单

```
[1] 一键启动守卫（接管 dsh web）    [5] 重置失败计数
[2] 查看状态                        [6] 自动挂载 dsh-qaq 备份插件
[3] 手动备份当前配置为 last-good    [7] 查看日志（error / access / host）
[4] 手动回滚到 last-good            [q] 退出
```

### 2.2 输入机制：行队列 asker（`createAsker`）

> 为什么不用 `readline.question`：管道/重定向输入会在 `preflight`（~2.5s）期间送达并关闭，
> `question()` 注册监听太晚 → 输入丢失、进程因 pending Promise 不持事件循环而静默退出。

- 创建接口时立即监听 `line` 事件，把输入**先入队**；prompt 时消费队列。
- EOF（stdin 关闭）→ 解析当前等待者为 `q`，无等待者则入队 `q`——重定向运行也走干净退出路径。

### 2.3 界面管理

- 每次渲染菜单前 `clearScreen()`（仅 TTY 的 ANSI `\x1b[2J\x1b[3J\x1b[H`）——窗口永远只留一屏。
- 持久头部：标题框 + 启动摘要 + 问题警告，每屏重打。
- 结果提示行：快速操作（备份/回滚/重置/挂载）结果以 `✔ <lastNotice>` 保留在菜单上方，不闪没。
- 详情视图（状态/日志）输出后 `[回车返回菜单]` 暂停。

### 2.4 守卫锁生命周期（关键）

- 受监督子进程健康后，锁**持续持有到子进程退出**（`watchSupervisor` 在 exit 时释放），期间：
  - 菜单顶部显示"🛡 守卫监控中"；再次选 [1] 被拒绝（提示先等退出）。
  - 每次启动都重新 `preflight`（全新自检），不会用过期的端口检查。
- Ctrl+C（SIGINT）：先杀受监督子进程再退出——不留进程占端口。
- 关闭窗口：Windows 向同控制台广播 `CTRL_CLOSE_EVENT`，守卫与子进程一起终止；
  残留锁由 PID 存活检查自动回收。

---

## 3. 备份插件自动挂载（src/install-plugin.ts）

### 3.1 为什么只动 bundle 列表，不动 user patch

DSH 从 `dsh.profile.bundles` 按序解析每个 bundle，读取其 package.json 的 `dsh.bundle.patch`
作为**插件层**自动加载。所以挂载 = 两步：

1. 把 `dsh-qaq` 加入 `dsh.profile.bundles`；
2. 在 `profiles/<name>/node_modules` 建 junction 指向 `packages/dsh-qaq`。

**绝不修改 `cordis.patch.yml`（user layer）**：再插一行 `id: dsh-qaq` 会与插件层重复 → `duplicate
loader entry id` 启动崩溃（真实集成抓到的缺陷）。对旧版残留的 manual insert 行只告警。

### 3.2 原子性与幂等

- 写前保留原始 package.json；链接失败 → 撤销全部写入并报错（绝不制造启动故障）。
- 已挂载（bundle 已在列表）→ 幂等跳过；junction 已存在 → 不重建。

### 3.3 插件行为

`dsh-qaq` 在 DSH host 内部运行：`ctx.get('loader')?.await?.()` 等 loader 树稳定后，
只做**存在性上报**（心跳 / 插件清单 / 状态），**不再在 settle 时写 last-good 快照**。
真正的 last-good 备份只发生在**一次真实用户对话**后——`ctx.on('session/event')` 收到
`user/message` 且 `source.kind === 'user'`（直接人类输入；插件注入 `kind === 'plugin'`、
模型/工具消息都不算）。因为只有人类真正发过消息，才证明这套配置**可用**：宿主 settle 但
Web UI 红屏时用户根本无法对话，因此坏配置**绝不会**被写成 last-good。失败启动（settle
reject）同样不写快照（`.catch(() => {})`）。

---

## 4. CLI 入口（bin/）

| 文件 | 作用 |
|------|------|
| `qaq.cmd` | Windows 透传包装（`qaq <args>`）：`cd` 到仓库根后 `node --import tsx/esm src\cli.ts %*`（开发模式直跑 TS 源码） |
| `qaq.mjs` | Node 入口（`bin` 字段）：有 `dist/qaq.mjs` 用 dist，否则 tsx 跑源码（`import.meta.url` 相对定位） |

**编码说明**：仓库已无 GBK 批处理文件——`qaq.cmd` 为纯 ASCII，按 UTF-8/LF 维护即可。
一键安装/构建入口统一走 CLI 命令 `qaq setup`（`src/setup.ts`），它强制 pnpm >= 11
（本地 pnpm 缺失或过老时回退 `npx pnpm@11`——见 `pnpm-workspace.yaml` 的 `allowBuilds` 键）。

---

## 5. 修改指南

- 加菜单项 → 改 `runConsole` 的 switch 与菜单打印；结果型操作用 `lastNotice`，详情型操作后加
  `await ask('[回车返回菜单] ')`。
- 改发现逻辑 → 只动 `env.ts`；`test/env.spec.ts` 覆盖 QAQ_DSH_CMD / --cwd / 兄弟目录扫描。
- 改插件挂载 → `install-plugin.ts` + `test/install-plugin.spec.ts`（幂等 + 不碰 user patch 断言）。
