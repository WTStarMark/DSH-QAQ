# 变更日志（Changelog）

QAQ —— DeepSeek Harness 启动容灾守卫。本文件依据 git 提交历史梳理全部重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/)——每个版本按 **新增 / 修复 / 变更 / 移除** 分组。

## [0.4.5] — 2026-08-21 · 守卫双重保障：配置指纹门控与防循环步进回滚

### 新增
- **last-good 配置指纹门控**：`recordSuccess` 只把「运行中 DSH 实际加载的配置」与「被快照的磁盘配置」指纹一致的配置盖章为 last-good。dsh-qaq 插件在开机时一次性上报本进程实际加载的配置指纹（`plugin-state.json` 的 `loadedFingerprint`），杜绝「运行进程健康于旧配置、而磁盘上新配置（如新启用的 bundle 插件）从未被启动验证」的污染——这正是 dsh-broken-theme 被记为 last-good 的根因。指纹不匹配时拒绝盖章并推送 `config-not-verified` 事件。
- **防死循环步进回滚**：回滚后若恢复的 last-good 本身就是故障源（恢复后仍红屏/崩溃），防死循环栅栏不再一刀切锁死；守卫按 `rollbackEscalation` 记录的回退偏移**步进回滚到更老的合法快照**（受限 `MAX_ESCALATION_STEPS` 步），直到找到可启动配置或已无更老快照才停手；无更老快照时仍维持栅栏停手。启动器 `cmdDsh`（回滚后重启循环）与侧载 `watch` 均已接入。

### 变更
- `store.ts` 的 `ProfileState` 新增 `rollbackEscalation`；`rollback.ts` 的 `maybeRollback` 支持 `allowEscalation` 与按偏移选择**有序合法快照列表**；`recordSuccess` 新增可选 `verifier` 门（guard/watch 两处调用点传入 `liveBootMatches`）。
- 新增 `src/verify-config.ts`（CLI 侧配置指纹算法 + 三者判定）；`shared-io.ts` 的 `PluginState` 增加 `loadedFingerprint`。
- 版本统一升至 `0.4.5`（`package.json` / `packages/dsh-qaq/package.json`）。

### 测试
- 新增 `verify-config.spec.ts`（指纹算法、`liveBootMatches` 三态、`recordSuccess` 门控拒绝/放行）与 `escalation.spec.ts`（步进回滚至更老快照、未选择时不破栅栏、无更老快照停手、成功清除回退状态）；`plugin.spec.ts` 增加插件↔CLI 指纹一致性用例。

---
## [0.4.4] — 2026-08-18 · 版本更新检测（Beta）与版本对齐

### 新增
- 版本更新检测（Beta）：TUI 头部显示当前版本号，新增「检测更新 (Beta)」菜单项；GitHub（<https://github.com/WTStarMark/QAQ>）存在更新时，状态区显示「- 有新更新 vX.X.X」。
- 确认更新流程：发现更新后再次按该菜单项，下载最新 master 源码包到 `~/.dsh/.qaq/update/`，并提示升级步骤（`qaq setup`）。

### 变更
- 版本对齐：`package.json` 与 `packages/dsh-qaq/package.json` 由 `0.1.0` 统一升至 `0.4.4`。

---

## [0.4.3] — 2026-08-18 · 文档重构与加固

### 变更
- README 改名：`README.zh.md` → `README.md`（默认中文主文档）、`README.md` → `README.EN.md`（英文版），互链已更新。
- 中英 README 均推荐 `qaq tui` 作为日常入口（全能仪表盘：启动、日志、插件、热更新、侧载 watch）。
- `qaq setup` 强制 pnpm >= 11（本地 pnpm 缺失或过老时回退 `npx pnpm@11`）——pnpm 10 会忽略 `allowBuilds` 键导致 esbuild 构建脚本被禁。
- 修正文档陈旧内容（已删除的启动器脚本、GBK 编码说明、测试数量、`qaq-web.cmd` 引用）。

### 新增
- 双语变更日志（`Changelog.md` / `Changelog.zh.md`），依据 git 历史梳理，按「新增 / 修复 / 变更 / 移除」分组。
- 零依赖风格门禁：`pnpm lint`（`scripts/check-style.mjs`）+ `.editorconfig` + CI 风格检查步骤。
- 浏览器发现增强：支持 `QAQ_CHROME` / `CHROME_PATH` 环境变量优先，以及 `$PATH` 扫描兜底。
- i18n 同步测试：`en` / `zh` 字典必须 key 完全一致。

### 修复
- 守卫锁 TOCTOU 竞态：锁文件改为 `wx`（O_EXCL）原子创建，并发实例严格串行；陈旧锁回收同样走原子创建。
- `README.md` 代码块嵌套损坏（```` ```cmd ```` 内嵌套 ```` ```bash ````，导致文字被吞进代码块）。
- 17 个源码文件缺少末尾换行。

### 移除
- `github-repo-stats` 流量报告工作流（`.github/workflows/github-repo-stats.yml`）。

---

## [0.3.3] — 2026-08-17 · 守卫加固

### 新增
- 回滚前**快照校验**——坏快照（JSON 损坏 / bundles 结构非法 / patch 为空）绝不还原；状态指针损坏时自动回退到最新合法自动快照（`f44d726`）。
- **环境/依赖类失败**（`EPERM`、`ERR_MODULE_NOT_FOUND`、unsupported engine 等）单独分类为 `env`：不计数、不回滚，给出可操作提示（`f44d726`）。
- **非红屏劣化信号**：已启用插件 fiber 落入 `failed` 态、探测期捕获 console error → 产生 `ui-degraded` 告警（不计分）（`f44d726`）。
- CI：新增 `github-repo-stats` 流量报告工作流（只读 token，报告以 artifact 交付）（`b0c5f24`、`b917bb0`）。

---

## [0.2.3] — 2026-08-17 · 插件热更新

### 新增
- 插件热更新三通道，全部默认关闭（`a23f560`）：
  - **client bundle 热更监控**——经 DSH client-HMR 热换 `lib/client.js`，CDP 重新探测验证 + 文件级回滚（快照存于 `~/.dsh/.qaq/hot-snapshots/`）；
  - **bundle 列表变化自动重启**——profile bundle 增删触发受监督重启；
  - **web dist 变化自动重启**——`apps/web/dist` 重建后触发受监督重启。
- dsh-qaq 插件在 TUI 打开时自动挂载，并提供手动重挂/覆盖更新入口（junction 目标校验、孤儿链接修复、用户数据保护）（`a23f560`）。

---

## [0.1.3] — 2026-08-17 · 备份策略与回滚硬化

### 新增
- TUI 备份管理器：自动/手动备份两群，独立保留配额（自动 10 份 / 手动 3 份）（`65e06af`）。
- README 双语界面截图（en/zh 并排）（`548e41d`）。

### 变更
- 备份策略硬化：自动备份（守卫确认健康 / 插件真实对话后产生）与手动备份（`qaq backup` / TUI `[3]`）分群独立保留（`65e06af`）。
- 确定性 UI 红屏（`did not activate … waiting for service`）**首次命中即回滚**，不再等满阈值（`65e06af`）。

---

## [0.0.3] — 2026-08-15 · 发布准备

### 新增
- 双语 README + LICENSE，仓库为 GitHub 发布整理就绪（`b648fe7`）。
- `.nvmrc` 钉版本 + 跨 OS CI 工作流（ubuntu + windows × Node 22/24，冻结 lockfile）（`f8404ba`）。
- 双语开发文档：英文为默认文件名、中文保留 `*.zh.md`（`9dac589`）；7 份深度文档（架构 / 守卫生命周期 / 状态与回滚 / UI 检测 / 控制台与环境 / 日志 / 测试），并在 README 建索引（`823ae4f`）。

### 修复
- `dist` ESM bundle 启动崩溃；dsh-qaq 插件改为**零运行时依赖**（运行时不再 import `@deepseek-ai`）（`12a9dcf`，随 PR #1）。

### 变更
- 项目归属 WTStarMark（LICENSE、包元数据、README）（`5224e0d`）。
- 「傻瓜式」统一更名为「懒人脚本」（`c1edf42`）；仓库布局改为表格、删除过时文档章节（`11124a5`）。
- 双语启动器拆分为 en + zh 变体；zh-CN 文档重命名为 `.zh`（`5336773`）。

### 移除
- 原型/冗余项目副本（6 个文件，1414 行）（`e5a19a0`）。
- 3 份规划类文档（设计方案/规划方案/草案），由开发向深度文档取代（`823ae4f`）。

---

## [0.0.2] — 2026-08-15 · 完善与修复

### 新增
- 瞬态失败重试（`retries=1`），一次性 Windows 抖动不计入失败计数（`7a0a262`）。
- 回滚确认前的 diff 预览；可调参数 `--confirm-ms` / `--ui-timeout` / `--threshold`（`7a0a262`）。
- 一键控制台、环境自动发现、插件安装器、结构化日志（`aed6a8d`）。
- UI 探测新增 Edge 浏览器候选（`ba81d11`）。
- 自动发现与当前目录并排的 DSH checkout（`645e59a`）。

### 修复
- 守卫泄漏/挂起：未 settle 的子进程强制清理、就绪探测健壮化、快照前复查真实 DOM（`3426faf`）。
- 回滚正确性：快照 manifest 记录真实 profile；尊重用户拒绝回滚（`1b2bd48`）。
- 启动器编码：`.cmd` 以 GBK/CP936 保存，中文 banner 在 zh-CN cmd 正常显示（`4604068`）。
- 控制台每次渲染菜单前清屏；移除冗余 banner（`94d3cc7`）。
- Logger 对空 home 加固；集成脚本改为位置无关（`7e9f585`）。
- loop-test profile 写入不带 BOM（`7ee6219`）。

### 变更
- README 补充新守卫行为说明（`e26b0ec`）。

---

## [0.0.1] — 2026-08-15 · 初始版本

### 新增
- 启动容灾守卫核心（M1–M6）：受监督启动 `dsh web`、经 headless Chrome/CDP 读取真实 DOM 的 host + UI 双线侦测、失败计数、回滚至 last-good、防死循环栅栏（`797aa53`）。
- `dsh-qaq` 备份插件：仅在**真实用户对话**发生后写 last-good 快照；持续上报存在性心跳（`797aa53`）。
- 交互式控制台（懒人脚本 CMD 菜单）、结构化多文件轮转日志（qaq / error / access / host）、原子写的状态存储与快照管理（`797aa53`）。

---

[English](./Changelog.md) · [简体中文](./Changelog.zh.md)
