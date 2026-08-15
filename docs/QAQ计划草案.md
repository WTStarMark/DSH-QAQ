# QAQ 计划草案

> **项目定位**：DeepSeek Harness（下称 DSH）的启动容灾守卫。
> 当 profile 配置损坏导致无法正常启动（宿主崩溃 或 Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。
>
> 本文是基于对 DSH 源码与本机真实故障的探索得出的**可实施设计草案**。阶段：**研讨定稿**，尚未动工实现。

---

## 0. 背景与本次故障样本（根因复盘）

### 0.1 真实故障现象

用户运行 `pnpm dsh web`：
- **宿主进程正常**：终端无错误、`http://127.0.0.1:3080` 正常暴露、`chrome-devtools-mcp` 正常连上。
- **Web UI 红屏**：页面显示
  ```
  HARNESS
  Failed to load plugins
  dsh-my-theme
  failed to apply loader entry 801bda0b (dsh-my-theme): cannot get property "theme" without inject
  ```
  刷新、重启均复现。

### 0.2 根因定位（经 curl 实测还原）

1. 失败源于 **DSH 浏览器端装配图的激活阶段**，而非宿主 boot。
   - 宿主 boot（`packages/boot/app-boot/src/index.ts` 的 `boot()` → `assertEntriesActivated()`）**正常 settle**。
   - 失败发生在浏览器端 `packages/client/web/src/boot.tsx` 的 `assertEntriesActive()`（第 216 行），它检查每个 loader entry 是否 ACTIVE；`dsh-my-theme` 的 fiber 因等待 `theme` 服务而 PENDING → 判失败 → 渲染 `Failed to load plugins`。
   - 此失败**仅存活于浏览器会话**，宿主对「UI 红屏」**无感知、无日志、无回报通道**。

2. `cannot get property "theme" without inject` 来自 `vendor/cordis/src/reflect.ts:144`。

3. 关键装配事实（curl `/` 拿到完整 `window.__DSH_BOOT__`）：
   - `@deepseek-ai/dsh-client-ui-theme` 是装配图内**独立行**，其 `client.js` 内确实 `provide('theme', ...)`（服务键 `theme`）。
   - `dsh-my-theme` 行 `inject: ["theme"]` —— **指向正确**，服务键存在且由 ui-theme 行提供。
   - 因此静态装配图**无法识别本次错误**：图是齐的、两个 bundle 都 200、依赖键能解析。唯独**浏览器真实激活**时 `theme` 未就绪。
   - **设计约束**：`inject` 引用的是**服务名**而非行 id；`theme` 服务由非同名行 `@deepseek-ai/dsh-client-ui-theme` 提供。静态校验**绝不能**用「行 id 集合匹配 inject」做，必须解析到「哪一行 provides 该服务名」。

### 0.3 对 QAQ 的核心启示

- 纯宿主监听（进程退出/端口/日志）**抓不到「UI 红屏」**——宿主是好的。
- 纯 curl 抓 HTML 也**抓不到红屏**（`<div id="root"></div>` 是空的，红屏文字是 React 运行时渲染）。
- 唯一**不侵入 DSH 源码**、又能**真实反映浏览器激活结果**的侦测手段是：**守卫用本机已有的 Chrome/Chromium 通过 CDP 打开页面，读取真实 DOM**。

---

## 1. 需求目标（用户拍板汇总）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 形态 | **插件 + CLI 守卫** 双形态组合使用（备份插件随 DSH；守卫独立可执行） |
| 2 | 插件职责 | **备份**「已知良好配置」到 `~/.dsh/.qaq/` |
| 3 | 守卫职责 | **回溯** + **重启**（侦测失败 → 回滚 → 自动重启） |
| 4 | 使用方式 | QAQ 接管 `dsh web` 启动，**以弹出可见的 CMD 窗口形式运行**（终端必须让用户看见） |
| 5 | UI 失败侦测 | **L3**：守卫用 CDP/无头浏览器读真实 DOM（不侵入 DSH） |
| 6 | 失败计数 | **宿主失败 / UI 失败两类分开计数** |
| 7 | 备份范围 | `profiles/<name>/package.json` + `cordis.patch.yml` 等启动配置；**不含**凭据/会话/storages/mcp-servers |
| 8 | 回滚粒度 | 回滚到**上一次成功启动的完整清单副本**；被回退版本**单独备份**便于手动还原 |
| 9 | 触发条件 | **连续失败 3 次**；设**自动确认可选项**（默认需用户确认，可 `--yes` 全自动） |
| 10 | 状态存储 | `~/.dsh/.qaq/`，**暂不纳入 git**；备份历史保留 `latest-good` + 最近 5 份时间戳 |
| 11 | 仓库位置 | 守卫（CLI）+ 备份插件结合使用；建议**独立仓库** `D:\Mochen\Project\qaq`（见 §5.2 讨论） |
| 12 | 重启 | 守卫自行 spawn `dsh web`，继承宿主 env + `DSH_HOME` + cwd；**防死循环**（回滚后仍失败则停手） |

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                         用户交互                             │
│  双击/命令触发 → 弹出可见 CMD 窗口（QAQ 守卫）              │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawn dsh web（继承 env/DSH_HOME/cwd）
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        QAQ CLI 守卫                          │
│                                                            │
│  [启动窗口]  spawn dsh web，监听 stdin/out/err + 端口就绪    │
│  [侦测器]    ① 宿主失败(host) ② UI 失败(ui, CDP 读 DOM)     │
│  [计数器]    ~/.dsh/.qaq/state.json  (hostN / uiN)         │
│  [回滚器]    连续3次同类失败 → 还原 latest-good → 备份坏版   │
│  [重启器]    spawn dsh web（继承环境）；防死循环            │
└──────────────┬─────────────────────────────┬───────────────┘
               │                             │
               │ CDP(无头浏览器,不侵入)       │ 读写
               ▼                             ▼
┌──────────────────────┐          ┌──────────────────────────┐
│  DSH 宿主 + Web UI    │          │  ~/.dsh/.qaq/            │
│  (本机 Chrome 复用)    │          │  latest-good/            │
└──────────────────────┘          │  history/<ts>/           │
                                  │  rolled-back/<ts>/       │
   ┌──────────────────────────────┤  state.json              │
   │  DSH 备份插件（仅备份,不改行为)│  log/                    │
   └──────────────────────────────┘                          │
```

### 2.1 两条侦测线（不侵入 DSH）

| 侦测线 | 触发 | 手段 | 覆盖 |
|--------|------|------|------|
| 宿主失败 host | `dsh` 进程 | 监听进程退出码 ≠ 0、启动窗口内端口未就绪、stdout/stderr 含 `plugin tree failed to load` / fail-loud 关键字 | 宿主 boot 崩 |
| UI 失败 ui | Web | 端口就绪后用 **CDP 打开页面**，等待 boot settle，读 `document.body` 是否含「Failed to load plugins」/ loader-status 失败态 | 浏览器端激活失败（本次样本） |

> **CDP 复用说明**：本机已有 `chrome-devtools-mcp` 在跑，说明存在可用 Chrome/Chromium。守卫优先尝试**连接已存在的 CDP 调试端口**（如 9222）；若不存在则**自发启动一个 headless Chrome**。两种都无需额外 Playwright 依赖（可选用原生的 `fetch` 调 CDP HTTP/WS 接口，或引入轻量的 `chrome-remote-interface`）。**这仍属于侦测，不修改 DSH 源码。**

---

## 3. 数据模型与存储（`~/.dsh/.qaq/`）

```
~/.dsh/.qaq/
├─ state.json              # 计数 + 元数据（见下）
├─ latest-good/            # 当前"已确认成功"的配置副本
│   ├─ manifest.json       # 快照元数据（profile名、时间、config指纹）
│   ├─ package.json        # profile 的 bundle 清单
│   └─ cordis.patch.yml    # profile 用户补丁    （+ 可扩展 settings.yaml）
├─ history/<ISO-ts>/       # 最近 N=5 份历史快照（同 latest-good 结构）
├─ rolled-back/<ISO-ts>/   # 被执行回滚的"坏配置"副本（便于手动还原）
└─ log/qaq.log             # 守卫运行日志
```

### 3.1 `state.json` 结构（草案）

```jsonc
{
  "version": 1,
  "profiles": {
    "web": {
      "hostFailures": 0,        // 宿主失败连续计数
      "uiFailures": 0,          // UI 失败连续计数
      "lastSuccess": "2026-08-14T16:20:00.000Z",
      "lastFailure": {
        "kind": "ui",            // "host" | "ui"
        "ts": "2026-08-14T16:25:00.000Z",
        "error": "dsh-my-theme: cannot get property \"theme\" without inject"
      },
      "lastGoodSnapshot": "history/2026-08-14T15:00:00.000Z"
    }
  },
  "config": {
    "autoConfirm": false        // --yes 时服务端/守卫设为 true
  }
}
```

### 3.2 快照内容（启动配置白名单）

- `profiles/<name>/package.json`（bundle 清单 —— 回滚核心）
- `profiles/<name>/cordis.patch.yml`
- `$DSH_HOME/cordis.patch.yml`（全局用户补丁，可选）
- 可扩展：`settings.yaml`（仅做结构校验，不强制回滚）
- **绝不纳入**：`.credentials.yaml`、`.anonymous-user-id`、`sessions/`、`storages/`、`mcp-servers/`。

---

## 4. 核心流程

### 4.1 写「成功」快照（由守卫驱动备份插件或守卫自身）

1. 守卫 spawn `dsh web` 成功后，进入**确认窗口**（例如稳定运行 ≥ 20s，或按需等待首次 UI boot settled）。
2. 若宿主无失败 **且**（若启用 L3）CDP 探得 UI 已 settled 且无红屏 → 判定 **成功**。
3. 将当前配置写入 `~/.dsh/.qaq/latest-good/`（原子写 + 保留到 `history/`，最多 5 份）；`state.json` 记 `lastSuccess`。
4. 「成功」的定义要避免把"宿主活但 UI 红屏"误记为成功 —— **必须等 L3 确认**（这是本方案与纯宿主方案的本质区别）。

### 4.2 侦测与计数

- 每次 `dsh` 退出或超时：
  - 宿主非零退出/启动失败 → `hostFailures++`，`uiFailures` 清零（两种失败互相打断连续计数）。
  - 宿主正常但 L3 探到 UI 红屏 → `uiFailures++`，`hostFailures` 清零。
  - 两者都正常 → 双计数清零，标记成功。
- 任一类计数达到 **3** → 触发回滚。

### 4.3 回滚

1. 读取 `latest-good/`。
2. 把 `package.json` + `cordis.patch.yml` 原子写回 `profiles/web/`。
3. 被替换的坏配置先复制到 `rolled-back/<ts>/`。
4. 默认**需用户确认**（CMD 窗口提示 Y/N）；`--yes` 跳过。
5. 回滚后 spawn 重启 `dsh web`。

### 4.4 防死循环

- 回滚后**本次新会话立即进入"已回滚"状态**：若重启后**再失败**（同一周期内），**停手**，打印明确指引（要求用户检查 `rolled-back/` 手动还原或手动修配置），不再自动回滚/重启相同快照，避免无限重启。
- 用一个「已回滚快速开关」记忆 + 时间窗（例如回滚后 5 分钟内不二次自动回滚）。

### 4.5 重启方式（接管 + 可见 CMD 窗口）

- 用户入口：`qaq dsh web` 或双击 `qaq-web.cmd` ⇒ 弹出一个**可见的 CMD 窗口**（`start`/`cmd /k` 方式），窗口内运行守卫并在其中 spawn `dsh web`。
- 继承：父环境变量、`DSH_HOME`（若有）、当前工作目录（`cwd`）。
- 可见窗口的意义：让用户在出问题时能看到 `dsh` 原样输出、看到回滚提示、能按 Y/N、能观察重启过程。

---

## 5. 组件划分与仓库组织

### 5.1 组件 A：DSH 备份插件（`dsh-qaq`，仅备份、不改行为）

- 位置：独立仓库 `D:\Mochen\Project\qaq\packages\dsh-qaq`（可构建/链接进 DSH profile）。
- 职责：作为 DSH plugin 挂载，宿主 boot settle 安全后把启动配置写 `latest-good/`。**不监听、不判断失败、不改 DSH 任何现有行为。**
- 与守卫的协作：它负责「写快照」，守卫负责「侦测 + 回滚 + 重启」。两者读同一 `~/.dsh/.qaq/`。

> 演进可选：未来若接受最小侵入，可在此插件上加 `GET /plugins/qaq/boot-state` 回传端点（见 §7）；当前阶段**不纳入**，保持不侵入。

### 5.2 组件 B：QAQ CLI 守卫（独立可执行）

- 位置：`D:\Mochen\Project\qaq`（含 `bin/qaq.*`、`src/`、`test/`）。
- 技术选型（草案）：
  - **语言/运行时**：Node + TypeScript + tsx（与 DSH 同栈，便于复用 `~/.dsh` 语义）；
  - **CDP**：优先连本机已启动 Chrome 的远程调试端口，否则 `launch` 一个 headless Chrome 实例（保底可用 `ws` + 手写 CDP 协议，或引入 `chrome-remote-interface`）；
  - **进程管理**：Node `child_process.spawn`（stdio 继承到可见 CMD 窗口）；不依赖 DSH 内部 API，直接操作文件与流程。
- 命令面（草案）：
  - `qaq dsh web` —— 接管启动（守卫 + 侦测 + 计数 + 可选回滚 + 重启）；
  - `qaq status` —— 显示 `state.json`、最近成功/失败；
  - `qaq backup` —— 手动写一次 `latest-good`；
  - `qaq restore --to rolled-back/<ts>` —— 手动还原本备份；
  - `qaq reset --profile web` —— 清零计数；
  - `qaq --yes` —— 全局自动确认。

### 5.3 仓库布局（推荐）

```
D:\Mochen\Project\qaq\
├─ package.json / pnpm-workspace.yaml（若为 monorepo）
├─ bin\qaq.cmd  /  bin\qaq-web.cmd     # 可见 CMD 窗口入口
├─ src\                              # 守卫逻辑
│   ├─ spawn-dsh.ts                  # 接管启动、继承 env/cwd、stdio→窗口
│   ├─ detector-host.ts              # 宿主失败侦测
│   ├─ detector-ui.ts                # L3 CDP DOM 侦测
│   ├─ store.ts                      # ~/.dsh/.qaq 读写（原子写 + 锁）
│   ├─ rollback.ts                   # 回滚 + 备份坏版 + 防死循环
│   ├─ cli.ts                        # 命令面
│   └─ log.ts
├─ packages\dsh-qaq\                 # DSH 备份插件（可链接进 profile）
│   ├─ src\index.ts                  # plugin: boot settle 后写快照
│   └─ package.json
└─ test\
```

---

## 6. 关键设计约束与风险（探索实证）

1. **`inject` 是服务名，不是行 id**：`theme` 由 `@deepseek-ai/dsh-client-ui-theme` 行提供。静态装配图校验必须解析到「provide 该服务名的行」，**不能**做行 id 集合匹配，否则会把本样本这种"图是对的"误判为坏或好不可靠。
2. **服务端 HTML 不含红屏 DOM**：想在线程/进程层判断必须做「真实渲染」（L3/CDP），无捷径。
3. **"宿主活、UI 红"是独立失败类**：必须与宿主失败分开计数（已定）。
4. **写成功快照的时机必须等 UI 确认**，否则会把"宿主活但 UI 红"误记为成功。
5. **并发/原子**：`~/.dsh/.qaq` 的读写需复用 DSH 的 `atomic-write` / `withFileLock` 思路（防两个守卫实例互踩）。
6. **防死循环**：回滚后同一周期二次失败必须停手。
7. **可见窗口**：CMD 窗口不可隐藏，承担进度/回滚提示/确认交互载体。
8. **备份绝不越界**：不碰凭据/会话/storages/mcp-servers（数据最小化 + 零敏感泄漏）。

---

## 7. 演进（可选，当前不做）

- 未来若接受最小侵入：在备份插件加 `GET /plugins/qaq/boot-state` + 浏览器端 `fetch` 回传，可让守卫**纯 curl** 读真实激活结果，替代 Partially 更重的 CDP 全渲染。本阶段保持不侵入，不放开关。

---

## 8. 里程碑（草案，供排期）

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 | 仓库初始化 + `qaq dsh web` 接管 spawn（可见 CMD 窗口，继承 env） | 手动 `qaq dsh web` 正常启动 DSH 且窗口可见 |
| M2 | 宿主失败侦测 + `state.json` 计数 | 模拟宿主崩配置，计数 +1 |
| M3 | L3 CDP UI 侦测（读真实 DOM） | 复现红屏样本，`uiFailures` 计数 +1 |
| M4 | 备份插件写 `latest-good`；成功判定（宿主无错 + UI settled） | 正常启动后 `~/.dsh/.qaq/latest-good/` 生成 |
| M5 | 回滚 + 坏版备份 + 自动确认开关 + 防死循环 | 连续 3 次失败自动回滚并重启；回滚后不再恶性循环 |
| M6 | 手动命令面（status/backup/restore/reset）、日志、测试 | 全命令可用，关键路径有测试 |

---

## 9. 待确认项

1. **CDP 无头浏览器**：允许守卫**自发启动一次 headless Chrome**（系统未开 9222 时）？—— 涉及稍重的浏览器进程管理；是否接受守卫临时起 Chrome 以换取 L3 可靠性。（推荐：接受）
2. **仓库位置**：上文推荐独立 `D:\Mochen\Project\qaq`，请确认；若你更想放 DSH monorepo 内亦可，但守卫是独立可执行、建议独立。
3. **成功判定窗口**：默认"端口就绪 + 稳定 20s + L3 UI settled"，是否合适。
4. **自动确认默认值**：默认 require 用户确认（Y/N），`--yes` 才全自动，是否接受。
