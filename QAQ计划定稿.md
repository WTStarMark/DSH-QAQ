# QAQ 计划定稿（基于真实复现数据面）

> **项目定位**：DeepSeek Harness（下称 DSH）的启动容灾守卫。
> 当 profile 配置损坏导致无法正常启动（宿主崩溃 或 Web UI 红屏）时，QAQ 自动回溯到「上一次成功启动」的配置快照并重启，同时保留被回退的坏配置便于手动还原。
>
> 本定稿基于 **2026-08-15 在隔离克隆上的真实复现实验** 验证了关键判据（见 §0.4）。阶段：**定稿可动工**。

---

## 0. 背景与真实复现数据面（试验验证）

### 0.1 原始故障现象（用户本机）

用户运行 `pnpm dsh web`：
- **宿主进程正常**：终端无错误、`http://127.0.0.1:3080` 正常暴露、chrome-devtools-mcp 正常连上。
- **Web UI 红屏**：页面显示 `HARNESS / Failed to load plugins / dsh-my-theme: cannot get property "theme" without inject`，刷新、重启均复现。

### 0.2 根因（源码已证实）

1. 失败发生在 **浏览器端装配图的激活阶段**，宿主 boot 正常 settle。
   - 宿主 boot：`packages/boot/app-boot/src/index.ts` 的 `boot()` → `assertEntriesActivated()` 正常。
   - 浏览器端：`packages/client/web/src/boot.tsx:216` `assertEntriesActive()` 扫描每个 loader entry，`dsh-my-theme` 的 fiber 因等待 `theme` 服务而 PENDING → throw → 渲染 `Failed to load plugins`。
2. `cannot get property "theme" without inject` 来自 `vendor/cordis/src/reflect.ts:144`。
3. 静态装配图无法识别该错误：图是齐的（`theme` 服务由非同名行 `@deepseek-ai/dsh-client-ui-theme` 提供，`inject` 引用的是服务名不是行 id），唯独浏览器真实激活时 `theme` 未就绪。

### 0.4 真实复现实验（本次新增，决定判据）

在隔离克隆构建 DSH 后，用独立 `DSH_HOME` 起两个实例（3081 坏/3082 好），用 **headless Chrome + CDP** 打开页面读真实 DOM。结论如下（**这些是用户存疑点 1/4 索要的真实错误数据面**）：

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

**② 决定性判据（L3 侦测必须用文本，不能穷举类名）：**
- 红屏的结构类名是 **CSS Modules 哈希**（`_boot_<hash>`、`_failedTitle_<hash>`），**跨构建不稳定**（哈希随 CSS 内容变化）：`.boot`、`.card`、`.wordmark`、`.failedTitle`、`.failed`、`.failedItem` 这几个选择器实测全部命中 **0**。
- 但固定文本 **`Failed to load plugins`** 稳定可命中（写在 `AppRoot.tsx:52`，属于 pinned model-visible/UI 文本）。**侦测标准 = `document.body.innerText 包含 "Failed to load plugins"`**，简单、跨版本可靠。
- **附带异常详情**：`.failedItem` 内文本 `web boot: N entry did not activate <id>: pending (waiting for service: <svc>)` 直接给出「哪个插件、缺哪个服务」——守卫可原样写日志，无需侵入 DSH。**本次实验即读到**：`web boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: neverProvidedService)`。

**③ 成功/失败判定可用文本区分（正反例均实测）：**
- 坏实例：`body.innerText` 精确含 `Failed to load plugins`（时间线：页面加载到红屏呈现约 0.5–1s，直接从「无 root」跳到「红屏」，无长时 spinner）。
- 好实例：渲染完整聊天 UI（sidebar/composer/模型选择），**不含** `Failed to load plugins`，并出现业务入口（如 `textarea.composer`、`.xzQq5a_frame` 框架）。**存活且健康可判据**：boot 区消失 + 出现业务容器（如 composer 输入框）。

**④ 关键边界**：服务端 HTML 里 `<div id="root"></div>` 是**空**的（React 运行时渲染），curl 抓 HTML 无法测红屏——与草案 §0.3 一致；只有 CDP 真实渲染才能读到。**这直接定死 L3 侦测手段。**

> 复现素材已留存于 `D:\Mochen\Project\QAQ\qaq-test-plugins\dsh-broken-theme`（注入永不存在的服务 → 确定性 PENDING）。可复用于 M3 验收与回归。

---

## 1. 需求目标（定稿）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 形态 | **插件 + CLI 守卫** 双形态（备份插件随 DSH；守卫独立可执行） |
| 2 | 插件职责 | **备份**「已知良好配置」到 `~/.dsh/.qaq/` |
| 3 | 守卫职责 | **回溯** + **重启**（侦测失败 → 回滚 → 自动重启） |
| 4 | 使用方式 | QAQ 接管 `dsh web`，以**可见 CMD 窗口**运行（终端可见） |
| 5 | UI 失败侦测 | **L3**：守卫用 headless Chrome **CDP 读文本**，判据=`body.innerText` 含 `Failed to load plugins`（不侵入 DSH） |
| 6 | 失败计数 | **宿主失败 / UI 失败两类分开计数** |
| 7 | 备份范围 | `profiles/<name>/package.json` + `cordis.patch.yml` 等启动配置；不含凭据/会话/storages/mcp-servers |
| 8 | 回滚粒度 | 回滚到上一次成功完整清单副本；被回退版本单独备份 |
| 9 | 触发条件 | 连续失败 **3** 次；默认需用户确认，可 `--yes` 全自动 |
| 10 | 状态存储 | `~/.dsh/.qaq/`，暂不纳入 git；保留 `latest-good` + 最近 5 份时间戳 |
| 11 | 仓库位置 | **独立仓库 `D:\Mochen\Project\qaq`**（存疑点 2 的自主决策，见 §5.2） |
| 12 | 重启 | 守卫 spawn `dsh web`，继承 env + `DSH_HOME` + cwd；防死循环 |

---

## 2. 架构总览

（同草案：守卫按需 spawn `dsh web`，两条侦测线；此处不重复，差异点在 §0.4 判据与 §5。）

### 2.1 两条侦测线

| 侦测线 | 触发 | 手段 | 判据 |
|--------|------|------|------|
| 宿主失败 host | `dsh` 进程 | spawn 后监听退出码、端口超时、stdout/stderr 关键字 | 进程 exit≠0 / 窗口内端口 N 秒未就绪（实测约 5–10s 即可判定） |
| UI 失败 ui | Web | 端口就绪后用 **headless Chrome + CDP** 打开页面，轮询 `document.body.innerText` | **含 `Failed to load plugins`** 即为失败；出现 composer/业务容器 + 无红屏文本即为成功 |

> **CDP 落地策略（定稿）**：守卫不加 Playwright。原生 `websocket-client`/CDP HTTP 接口即可（本次实验即用原生 CDP 驱动成功）。优先复用本机已在跑的 Chrome/CDP 调试端口；否则 spawn 独立 headless Chrome，`--user-data-dir` 用独立临时目录，**必须带 `--remote-allow-origins=*`**（本次实测：不带该 flag，CDP WebSocket 握手 403 被拒），用后清理/user-data 一次性。

---

## 3. 数据模型与存储（同草案 §3）

`~/.dsh/.qaq/` 下：
- `state.json`：`profiles.<name>.hostFailures / uiFailures / lastSuccess / lastFailure{knd,ts,error} / lastGoodSnapshot` + `config.autoConfirm`。
- `latest-good/`：manifest.json + package.json + cordis.patch.yml（+ 可扩展 settings.yaml 仅校验）。
- `history/<ISO-ts>/`（最近 5 份）、`rolled-back/<ISO-ts>/`、`log/qaq.log`。

---

## 4. 核心流程

### 4.1 写「成功」快照
1. 守卫 spawn `dsh web`，等端口就绪。
2. **L3 确认**：CDP 打开页面，轮询文本——出现 composer/业务容器**且**恒 `body.innerText` 无 `Failed to load plugins`，持续稳定 ≥ 20s → 判成功。
3. 写 `latest-good/`（原子写 + 保留 history 最近 5 份）。

### 4.2 侦测与计数
- 进程非零退出/端口超时 → `hostFailures++`，`uiFailures` 清零。
- 端口就绪但 L3 读到红屏文本 → `uiFailures++`，`hostFailures` 清零。
- 双正常 → 双清零、标记成功。
- 任一计数到 **3** → 触发回滚。

### 4.3 回滚
1. 读 `latest-good/`。
2. `package.json` + `cordis.patch.yml` 原子写回 `profiles/web/`。
3. 坏配置先复制到 `rolled-back/<ts>/`。
4. 默认 Y/N 确认；`--yes` 跳过。

### 4.4 防死循环
- 回滚后进入「已回滚」状态（时间窗 5 分钟）：若重启后同周期再失败 → **停手**，打印指引（检查 `rolled-back/` 手动还原），不再自动回滚/重启。

### 4.5 重启方式
- 入口 `qaq dsh web` / 双击 `qaq-web.cmd` → 弹可见 CMD 窗口，窗口内 spawn `dsh web`，继承 env/`DSH_HOME`/cwd。

---

## 5. 组件划分与仓库组织（含存疑点 2/3/5 自主决策）

### 5.1 组件 A：DSH 备份插件（`dsh-qaq`，仅备份不改行为）
- 位置：独立仓库 `D:\Mochen\Project\qaq\packages\dsh-qaq`，可链接进 profile。
- 职责：宿主 boot settle 安全后写 `latest-good/`。不监听、不判失败、不改 DSH 行为。

### 5.2 组件 B：QAQ CLI 守卫（存疑点 2/3/5 自主决策）
- **存疑点 2 → 独立仓库**：守卫完全独立于 DSH 存在，**单独 clone/自足**，不依赖 DSH 源码树，不与其安装、构建、运行干涉。理由：守卫是「外部监督者」，必须能在 DSH 启动失败时仍可靠动作；若放在 DSH monorepo 内，DSH 崩了守卫也跟着不可用。选 `D:\Mochen\Project\qaq`。
- **存疑点 3 → 纯用户态、最小依赖**：守卫用 **Node ≥ 22 + 原生 CDP（websocket 客户端）+ 手写 DOM 文本探针**，不加 Playwright/Puppeteer（避免重型浏览器依赖与版本耦合）；可用 esbuild 打成单文件可执行。命令面 `qaq dsh web` / `qaq status` / `qaq backup` / `qaq restore --to <ts>` / `qaq reset --profile web` / `qaq --yes`。
- **存疑点 5 → 文本判据 + 业务容器双条件**：UI 失败判据定为 `body.innerText.includes('Failed to load plugins')`（实测稳定）；「成功」需 + 出现 composer 业务容器。不依赖哈希类名。

### 5.3 仓库布局（同草案 §5.3）

---

## 6. 关键设计约束与风险（更新）

1. **`inject` 是服务名不是行 id**（源码证实）。
2. **服务端 HTML 不含红屏 DOM**，必须 CDP 真实渲染（本次实测证实空 `#root`）。
3. **"宿主活、UI 红"是独立失败类**（实测：宿主打印 URL、L3 却读到红屏）。
4. **写成功快照必须等 L3 确认**（实测好实例会渲染业务 UI、无红屏文本，时序清晰）。
5. **CSS Modules 类名哈希不可用于选择器**（本次实测 `.failedTitle` 等命中 0）→ 用固定文本判据。
6. **并发/原子**：复用 `atomic-write`/锁思路。
7. **可见窗口**承担交互载体。
8. **备份绝不越界**。
9. **新增风险 R**：headless Chrome 用独立 `user-data-dir` + `--remote-allow-origins=*`，防与用户浏览器/CDP 冲突、防 403。

---

## 7. 演进（可选，当前不做）
- 若未来接受最小侵入：备份插件加 `GET /plugins/qaq/boot-state` 端点，允许守卫**纯 curl** 读真实激活结果，替代较重 CDP 全渲染。本阶段保持不侵入。

---

## 8. 里程碑（基于本次雏形调整）

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 | 仓库初始化 + `qaq dsh web` 接管 spawn（可见 CMD，继承 env） | 手动启动 DSH 且窗口可见 |
| M2 | 宿主失败侦测 + `state.json` 计数 | 模拟宿主崩配置，hostFailures+1 |
| M3 | **L3 CDP 文本侦测（判据=`body.innerText` 含 `Failed to load plugins`）** | **用 `dsh-broken-theme` 复现样本，uiFailures+1**（素材已备好） |
| M4 | 备份插件写 `latest-good`；成功判定（宿主无错 + L3 业务 UI 呈现） | 正常启动生成 `latest-good/` |
| M5 | 回滚 + 坏版备份 + 自动确认 + 防死循环 | 连续 3 次失败自动回滚重启；回滚后不再恶性循环 |
| M6 | 手动命令面 + 日志 + 测试 | 全命令可用，关键路径有测试 |

---

## 9. 待确认项 → 定稿结论

1. **CDP 无头浏览器**：**接受**守卫自发起独立 headless Chrome（带 `--remote-allow-origins=*`），以换取 L3 可靠性。（本次实测验证可行。）
2. **仓库位置**：定稿为**独立 `D:\Mochen\Project\qaq`**。
3. **成功判定窗口**："端口就绪 + 稳定 20s + L3 业务 UI 呈现"——**接受**。
4. **自动确认默认值**：默认 require 用户确认，`--yes` 全自动——**接受**。

---

## 附：本次复现实验的操作留痕（可复现）

- 构建：`pnpm install && pnpm run build:lib && pnpm run build:web`（克隆内，耗时约数分钟）。
- 坏插件：`qaq-test-plugins/dsh-broken-theme`（client half `inject=['neverProvidedService']`，确定性红屏）。
- 实例：`DSH_HOME=<隔离home> node --import tsx/esm apps/cli/src/bin.ts web --port 3081/3082`。
- 侦测：headless Chrome `--remote-debugging-port=9333 --remote-allow-origins=*` + 原生 Python CDP WebSocket 驱动（脚本 `qaq/cdp_probe.py`、`cdp_detail.py`）。
- 正/反两例均实测通过，真实 3080 实例未受任何影响（自始至终未触碰其 home/profile/进程）。
