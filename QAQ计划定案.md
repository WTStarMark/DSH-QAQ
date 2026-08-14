# QAQ 计划定案

> **项目**：DeepSeek Harness（下称 DSH）的启动容灾守卫。
> **职责**：当 profile 配置损坏导致 DSH 无法正常启动（宿主崩溃 或 Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。
>
> **阶段**：定案，可动工实现。本文为唯一权威需求/设计来源，替代草案。
> **依据**：DSH 源码审计 + 2026-08-15 隔离克隆真实复现实验（§0.4）。

---

## 0. 背景与根因

### 0.1 原始故障现象（本机样本）

运行 `pnpm dsh web`：
- **宿主进程正常**：终端无错误、`http://127.0.0.1:3080` 正常暴露、chrome-devtools-mcp 正常连上。
- **Web UI 红屏**：页面显示
  ```
  HARNESS
  Failed to load plugins
  dsh-my-theme: cannot get property "theme" without inject
  ```
  刷新、重启均复现。

### 0.2 根因（源码证实）

1. 失败存在于 **浏览器端装配图的激活阶段**，宿主 boot 正常。
   - 宿主：`packages/boot/app-boot/src/index.ts` 的 `boot()` → `assertEntriesActivated()` 正常 settle。
   - 浏览器：`packages/client/web/src/boot.tsx:216` `assertEntriesActive()` 扫描 loader entry 的 fiber 状态；`dsh-my-theme` 因等待 `theme` 服务而 PENDING → throw → 渲染 `Failed to load plugins`。
2. `cannot get property "theme" without inject` 来自 `vendor/cordis/src/reflect.ts:144`。
3. 静态装配图**无法识别**此错误：图是齐的（`theme` 服务由非同名行 `@deepseek-ai/dsh-client-ui-theme` 提供），唯独浏览器真实激活时 `theme` 未就绪。
4. **设计约束**：`inject` 引用的是**服务名**而非行 id；静态校验绝不能拿「行 id 集合匹配 inject」做，必须解析到「哪一行 provides 该服务名」。

### 0.3 侦测手段的根本结论

- 纯宿主监听（退出码/端口/日志）**抓不到 UI 红屏**——宿主是好的。
- 纯 curl 抓 HTML 也**抓不到红屏**——`<div id="root"></div>` 是空的，红屏由 React 运行时渲染。
- 唯一不侵入 DSH、又能真实反映浏览器激活结果的手段：**守卫用本机 Chrome（headless）通过 CDP 打开页面、读取真实 DOM**。

### 0.4 真实复现实验（决定判据 —— 本次实测）

在隔离克隆构建 DSH，用独立 `DSH_HOME` 起坏(3081)/好(3082)两实例，**headless Chrome + CDP** 读真实 DOM。实验素材另存于 `D:\Mochen\Project\QAQ\qaq-test-plugins\dsh-broken-theme`（注入永不存在的服务 → 确定性红屏），可复用于 M3 与回归。

**① 真实红屏 DOM 结构（CSS Modules 哈希类名）：**
```
<div id="root">
  <div class="_boot_9gj4p_6"><div class="_card_9gj4p_13">
    <div class="_wordmark_9gj4p_20">HARNESS</div>
    <div class="_failed_9gj4p_47">
      <div class="_failedTitle_9gj4p_54">Failed to load plugins</div>
      <div class="_failedItem_9gj4p_61">web boot: 1 entry did not activate
        dsh-broken-theme: pending (waiting for service: neverProvidedService)</div>
    </div>
  </div></div>
</div>
```

**② 决定判据（必须用文本，不能穷举类名）**：
- 结构类名是 **CSS Modules 哈希**（`_boot_<hash>` 等），跨构建不稳定：实测 `.boot`、`.card`、`.wordmark`、`.failedTitle`、`.failed`、`.failedItem` 选择器全部命中 **0**。
- 固定文本 **`Failed to load plugins`** 稳定可命中（`AppRoot.tsx:52`，属 pinned UI 文本）。**UI 失败判据 = `document.body.innerText.includes('Failed to load plugins')`**。
- **异常详情**：`.failedItem` 文本 `web boot: N entry did not activate <id>: pending (waiting for service: <svc>)` 直接给出「哪个插件、缺哪个服务」，守卫原样写日志即可，零侵入。

**③ 正/反两例实测**：
- 坏实例：`body.innerText` 精确含红屏三段；页面加载到红屏约 0.5–1s，从「无 root」直接跳「红屏」，无长时 spinner。
- 好实例：渲染完整聊天 UI（sidebar/composer/模型选择），**不含**红屏文本，出现业务入口（如 `textarea.composer` / `.xzQq5a_frame` 框架）。
- **成功判据**：boot 区消失 + 出现 composer 业务容器 + 恒无红屏文本，稳定 ≥ 20s。

**④ CDP 布线实测**：headless Chrome 必须带 **`--remote-allow-origins=*`**，否则 CDP WebSocket 握手 403 被拒；用**独立 `--user-data-dir`** 防与用户浏览器冲突。

---

## 1. 需求目标（定案）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 形态 | **插件 + CLI 守卫** 双形态（备份插件随 DSH；守卫独立可执行） |
| 2 | 插件职责 | **备份**「已知良好配置」到 `~/.dsh/.qaq/` |
| 3 | 守卫职责 | **回溯** + **重启**（侦测失败 → 回滚 → 自动重启） |
| 4 | 使用方式 | QAQ 接管 `dsh web`，以**可见 CMD 窗口**运行（终端可见） |
| 5 | UI 失败侦测 | **L3**：headless Chrome + CDP 读文本；判据 = `body.innerText` 含 `Failed to load plugins`（不侵入 DSH） |
| 6 | 失败计数 | **宿主失败 / UI 失败分开计数** |
| 7 | 备份范围 | `profiles/<name>/package.json` + `cordis.patch.yml` 等启动配置；不含凭据/会话/storages/mcp-servers |
| 8 | 回滚粒度 | 回滚到上一次成功完整清单副本；被回退版本单独备份 |
| 9 | 触发条件 | 连续失败 **3** 次；默认需用户确认，`--yes` 全自动 |
| 10 | 状态存储 | `~/.dsh/.qaq/`，暂不纳入 git；保留 `latest-good` + 最近 5 份时间戳 |
| 11 | 仓库位置 | **独立仓库 `D:\Mochen\Project\qaq`** |
| 12 | 重启 | 守卫 spawn `dsh web`，继承 env + `DSH_HOME` + cwd；防死循环 |

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
│   [启动窗口]  spawn dsh web，监听 stdin/out/err + 端口就绪    │
│   [侦测器]    ① 宿主失败(host) ② UI 失败(ui, CDP 读文本)     │
│   [计数器]    ~/.dsh/.qaq/state.json  (hostN / uiN)         │
│   [回滚器]    连续3次同类失败 → 还原 latest-good → 备份坏版   │
│   [重启器]    spawn dsh web（继承环境）；防死循环            │
└──────────────┬─────────────────────────────┬───────────────┘
               │  CDP(headless Chrome,不侵入)  │ 读写
               ▼                              ▼
┌──────────────────────┐           ┌──────────────────────────┐
│  DSH 宿主 + Web UI    │           │  ~/.dsh/.qaq/            │
│  (本机 Chrome 复用)    │           │  latest-good/ history/   │
└──────────────────────┘           │  rolled-back/ state.json │
   ┌───────────────────────────────┤  log/                    │
   │  DSH 备份插件（仅备份,不改行为) │                          │
   └───────────────────────────────┘                          │
```

### 2.1 两条侦测线

| 侦测线 | 触发 | 手段 | 判据 |
|--------|------|------|------|
| 宿主失败 host | `dsh` 进程 | spawn 后监听退出码、端口超时、stdout/stderr 关键字 | 进程 exit≠0 / 窗口内端口 N 秒未就绪（实测约 5–10s 可判定） |
| UI 失败 ui | Web | 端口就绪后 headless Chrome + CDP 打开页面，轮询 `document.body.innerText` | **含 `Failed to load plugins`** 即失败；出现 composer 业务容器 + 无红屏文本即成功 |

> **CDP 落地**：原生 `websocket-client`/CDP HTTP 接口即可（实验即用原生 CDP 驱动）。优先复用本机已在跑的 Chrome/CDP 调试端口；否则 spawn 独立 headless Chrome（`--remote-allow-origins=*` + 独立 `--user-data-dir`，用后清理）。

---

## 3. 数据模型与存储（`~/.dsh/.qaq/`）

```
~/.dsh/.qaq/
├─ state.json              # 计数 + 元数据
├─ latest-good/            # 当前"已确认成功"配置副本
│   ├─ manifest.json       # 快照元数据(profile名、时间、config指纹)
│   ├─ package.json        # bundle 清单
│   └─ cordis.patch.yml    # 用户补丁（可扩展 settings.yaml，仅校验）
├─ history/<ISO-ts>/       # 最近 N=5 份历史快照（同 latest-good 结构）
├─ rolled-back/<ISO-ts>/   # 被执行回滚的“坏配置”副本（便于手动还原）
└─ log/qaq.log             # 守卫运行日志
```

**`state.json`（草案）**：
```jsonc
{
  "version": 1,
  "profiles": {
    "web": {
      "hostFailures": 0,
      "uiFailures": 0,
      "lastSuccess": "2026-08-15T00:00:00.000Z",
      "lastFailure": { "kind": "ui", "ts": "...", "error": "web boot: ... pending (waiting for service: ...)" },
      "lastGoodSnapshot": "history/2026-08-15T00:00:00.000Z"
    }
  },
  "config": { "autoConfirm": false }
}
```

**备份范围（绝不越界）**：
- 纳入：`profiles/<name>/package.json`、`profiles/<name>/cordis.patch.yml`、可扩展 `settings.yaml`（仅结构校验）。
- 绝不纳入：`.credentials.yaml`、`.anonymous-user-id`、`sessions/`、`storages/`、`mcp-servers/`。
- **`rolled-back/` 坏配置也绝不写密文文件**。

---

## 4. 核心流程

### 4.1 写「成功」快照
1. 守卫 spawn `dsh web`，等端口就绪。
2. **L3 确认**：CDP 打开页面轮询——出现 composer/业务容器**且**恒 `body.innerText` 无红屏文本，稳定 ≥ 20s → 判成功。
3. 写 `latest-good/`（原子写 + 保留 history 最近 5 份）。

### 4.2 侦测与计数
- 进程非零退出/端口超时 → `hostFailures++`，`uiFailures` 清零。
- 端口就绪但 L3 读到红屏 → `uiFailures++`，`hostFailures` 清零。
- 双正常 → 双清零、标记成功。
- 任一计数到 **3** → 触发回滚。**回滚是重破坏操作，回滚前记录「当前配置 vs latest-good 的 diff」供用户确认**。

### 4.3 回滚
1. 读 `latest-good/`。
2. `package.json` + `cordis.patch.yml` 原子写回 `profiles/web/`。
3. 坏配置先复制到 `rolled-back/<ts>/`。
4. 默认 Y/N 确认；`--yes` 跳过。
5. 回滚后 spawn 重启 `dsh web`。

### 4.4 防死循环
- 回滚后进入「已回滚」状态（时间窗 5 分钟）：重启后再失败（同窗口）→ **停手**，打印指引（检查 `rolled-back/` 手动还原/修配置），不再自动回滚/重启相同快照。

### 4.5 重启方式
- 入口 `qaq dsh web` / 双击 `qaq-web.cmd` → 弹出**可见 CMD 窗口**（窗口内运行守卫并 spawn `dsh web`）。
- 继承：父环境变量、`DSH_HOME`、当前工作目录。
- 可见窗口承担：`dsh` 原样输出、回滚提示、Y/N 确认、重启过程观察。

---

## 5. 组件划分与仓库组织

### 5.1 组件 A：DSH 备份插件（`dsh-qaq`，仅备份不改行为）
- 位置：独立仓库 `D:\Mochen\Project\qaq\packages\dsh-qaq`（可链接进 DSH profile）。
- 职责：宿主 boot settle 后把启动配置写 `latest-good/`。**不监听、不判失败、不改 DSH 行为。**
- 与守卫协作：它写快照，守卫侦测+回滚+重启，读同一 `~/.dsh/.qaq/`。

### 5.2 组件 B：QAQ CLI 守卫（独立可执行）
- 位置：`D:\Mochen\Project\qaq`。
- **技术选型（定案）**：
  - 语言/运行时：Node ≥ 22 + TypeScript + tsx（与 DSH 同栈）；**可 esbuild 打成单文件可执行**，完全自足。
  - **CDP**：原生 `websocket-client`（或 `chrome-remote-interface`）驱动 headless Chrome；优先连已有 CDP 端口，否则 spawn 独立 headless（`--remote-allow-origins=*` + 独立 user-data-dir）。**不加 Playwright/Puppeteer**。
  - 进程管理：Node `child_process.spawn`，stdio 继承到可见 CMD 窗口；不依赖 DSH 内部 API，直接操作文件与流程，**不与 DSH/插件干涉**。
- **命令面**：
  - `qaq dsh web` —— 接管启动（守卫 + 侦测 + 计数 + 可选回滚 + 重启）
  - `qaq status` —— 显示 `state.json`、最近成功/失败
  - `qaq backup` —— 手动写一次 `latest-good`
  - `qaq restore --to rolled-back/<ts>` —— 手动还原本备份
  - `qaq reset --profile web` —— 清零计数
  - `qaq --yes` —— 全局自动确认

### 5.3 仓库布局
```
D:MochenProjectqaq├─ package.json / pnpm-workspace.yaml（若 monorepo）
├─ binqaq.cmd  /  binqaq-web.cmd     # 可见 CMD 窗口入口
├─ src                              # 守卫逻辑
│   ├─ spawn-dsh.ts                  # 接管启动、继承 env/cwd、stdio→窗口
│   ├─ detector-host.ts              # 宿主失败侦测
│   ├─ detector-ui.ts                # L3 CDP 文本侦测
│   ├─ store.ts                      # ~/.dsh/.qaq 读写(原子写+锁)
│   ├─ rollback.ts                   # 回滚+备份坏版+防死循环
│   ├─ cli.ts                        # 命令面
│   └─ log.ts
├─ packagesdsh-qaq                 # DSH 备份插件
│   ├─ srcindex.ts                  # plugin: boot settle 后写快照
│   └─ package.json
└─ test```

---

## 6. 关键设计约束与风险（实证）

1. **`inject` 是服务名不是行 id**：静态校验必须解析到「provide 该服务名的行」，不能做行 id 集合匹配。
2. **服务端 HTML 不含红屏 DOM**：`<div id="root">` 为空，判断必须 CDP 真实渲染（实测证实）。
3. **"宿主活、UI 红"是独立失败类**：必须与宿主失败分开计数（实测：宿主打印 URL、L3 却读到红屏）。
4. **写成功快照必须等 L3 确认**，否则把"宿主活但 UI 红"误记为成功。
5. **CSS Modules 哈希类名不可作选择器**（实测 `.failedTitle` 等命中 0）→ 用固定文本 `Failed to load plugins` 判据。
6. **并发/原子**：复用 `atomic-write`/锁，防两守卫互踩。
7. **防死循环**：回滚后同周期二次失败必须停手。
8. **可见窗口**：CMD 窗口不可隐藏，承担交互载体。
9. **备份绝不越界**：不碰凭据/会话/storages/mcp-servers。
10. **新增风险 R**：headless Chrome 用独立 user-data-dir + `--remote-allow-origins=*`，防与用户浏览器冲突、防 CDP 403（实测踩坑）。

---

## 7. 演进（可选，当前不做）
未来若接受最小侵入：备份插件加 `GET /plugins/qaq/boot-state` 端点，允许守卫**纯 curl** 读真实激活结果，替代较重 CDP 全渲染。本阶段保持不侵入。

---

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 | 仓库初始化 + `qaq dsh web` 接管 spawn（可见 CMD，继承 env） | 手动 `qaq dsh web` 正常启动 DSH 且窗口可见 |
| M2 | 宿主失败侦测 + `state.json` 计数 | 模拟宿主崩配置，`hostFailures`+1 |
| M3 | **L3 CDP 文本侦测**（判据=`Failed to load plugins`） | 用 `dsh-broken-theme` 复现样本，`uiFailures`+1（素材已备） |
| M4 | 备份插件写 `latest-good`；成功判定 | 正常启动生成 `latest-good/` |
| M5 | 回滚 + 坏版备份 + 自动确认 + 防死循环 | 连续 3 次失败自动回滚重启；回滚后不再恶性循环 |
| M6 | 手动命令面 + 日志 + 测试 | 全命令可用，关键路径有测试 |

---

## 9. 决策记录（原待确认项 → 定案）

1. **CDP 无头浏览器**：接受守卫自发起独立 headless Chrome（`--remote-allow-origins=*`）以换取 L3 可靠性。（实测验证可行。）
2. **仓库位置**：独立 `D:\Mochen\Project\qaq`。
3. **成功判定窗口**：“端口就绪 + 稳定 20s + L3 业务 UI 呈现”——接受。
4. **自动确认默认值**：默认 require 用户确认，`--yes` 全自动。

---

## 附：复现实验留痕（可复现，供 M3/回归）

- 构建：`pnpm install && pnpm run build:lib && pnpm run build:web`（克隆内，数分钟）。
- 坏插件：`qaq-test-plugins/dsh-broken-theme`（client half `inject=['neverProvidedService']`，确定性红屏）。
- 实例：`DSH_HOME=<隔离home> node --import tsx/esm apps/cli/src/bin.ts web --port <P>`。
- 侦测：headless Chrome `--remote-debugging-port=9333 --remote-allow-origins=*` + 原生 Python CDP WebSocket（脚本 `qaq/cdp_probe.py`、`qaq/cdp_detail.py`）。
- 正/反两例均实测通过；真实 3080 实例全程未受影响。
