/**
 * Minimal in-process i18n for the guard's user-facing surface (console UI,
 * pre-launch preflight text, install-plugin results). Two locales — `en` and
 * `zh`. The default is `zh` (the original behavior) unless `--lang en` or
 * `$QAQ_LANG=en` says otherwise.
 *
 * Keys are dot-namespaced by area (console.*, env.*, cli.*, plugin.*). Values
 * support `{name}`-style interpolation. `en` and `zh` must stay key-for-key in
 * sync — test/i18n.spec.ts asserts the two dictionaries have identical keys.
 */
export type Lang = 'en' | 'zh'

export function isLang(s: unknown): s is Lang {
  return s === 'en' || s === 'zh'
}

/** Resolve the active language: `--lang en|zh` wins, then `$QAQ_LANG`, else `zh`. */
export function resolveLang(argv: string[], env: Record<string, string | undefined> = process.env): Lang {
  const i = argv.indexOf('--lang')
  const arg = i >= 0 ? argv[i + 1] : undefined
  if (arg !== undefined && isLang(arg)) return arg
  const fromEnv = (env.QAQ_LANG ?? '').toLowerCase()
  if (isLang(fromEnv)) return fromEnv
  return 'zh'
}

export type T = (key: string, vars?: Record<string, string | number>) => string

/** English strings. Exported so tests can assert key parity with `zh`. */
export const en: Record<string, string> = {
  // console.ts — header / menu
  'console.header.title': 'QAQ - DeepSeek Harness Launch Resilience Guard',
  'console.menu.title': 'Main menu',
  'console.menu.profile': ' (profile {name})',
  'console.menu.1': 'Start the guard (take over dsh web)',
  'console.menu.2': 'View status',
  'console.menu.3': 'Back up the current profile as last-good',
  'console.menu.4': 'Roll back to last-good',
  'console.menu.5': 'Reset failure counters',
  'console.menu.6': 'Mount the dsh-qaq backup plugin',
  'console.menu.7': 'View logs (error.log / access.log / host.log)',
  'console.menu.q': 'Quit',
  'console.menu.prompt': 'Please choose: ',
  'console.menu.unknown': 'Unknown option, try again.',
  'console.guard.running': '🛡 Guard active: dsh web is running in the background (pressing [1] is refused; wait for it to exit)',
  'console.notice.prefix': '✔ ',

  // console.ts — state / logs
  'console.state.title': '—— Current guard state (profile {name}) ——',
  'console.state.noSnapshot': '(no snapshot yet)',
  'console.logs.none': '(no logs)',
  'console.logs.error': '—— error.log (recent) ——',
  'console.logs.access': '—— access.log (recent) ——',
  'console.logs.host': '—— host.log (recent) ——',
  'console.logs.return': '[Press Enter to return to menu] ',
  'console.notify.exit': '\n[notice] dsh web exited (code={code}), guard lock released.',

  // console.ts — launch flow
  'console.launch.alreadyRunning': '\n[guard] A supervised dsh web is already running here. Return to the menu and wait for it to exit.',
  'console.launch.preflightError': '\n[error] Pre-launch checks failed; cannot start the guard:',
  'console.launch.preflightPass': '\n✅ Pre-launch checks passed',
  'console.launch.preflightSuffix': '. Launching:',
  'console.launch.confirm': 'Start the guard and take over dsh web?',
  'console.launch.cancelled': 'Cancelled.',
  'console.launch.error': '[error] {msg}',
  'console.launch.ok': '\n✅ dsh web healthy: {url}',
  'console.launch.monitoring': 'Guard is monitoring. Press Enter to return to the menu, or close this window to stop.',
  'console.launch.rolledBack': '\n[rollback] Auto-rolled back to last-good; restarting dsh web…',
  'console.launch.rolledBackOk': '\n✅ Restart after rollback healthy: {url}',
  'console.launch.rolledBackFail': '\n[error] Still failing after rollback (kind={kind}). Inspect the bad config in {dir}.',
  'console.launch.cancelledRollback': '\n[cancel] You declined the rollback; no auto-restart. Inspect {dir}.',
  'console.launch.failed': '\n[failure] Boot failed kind={kind}: {error}.',
  'console.launch.guardError': '\n[guard error] {msg}',

  // console.ts — menu actions
  'console.backup.done': 'Backed up the current profile as last-good.',
  'console.restore.noSnapshot': 'No last-good snapshot yet; back up first or start a healthy boot.',
  'console.restore.confirm': 'Roll profile back to last-good?',
  'console.restore.done': 'Rolled back to last-good.',
  'console.reset.done': 'Failure counters reset.',
  'console.exit': 'Guard console exited. For issues, see {dir} or the README.',

  // tui.ts — full-screen dashboard labels
  'tui.quit': 'quit',
  'tui.lang': 'lang',
  'tui.langLabel': 'language: {l}',
  'tui.guard.idle': 'guard: idle',
  'tui.state.host': 'host failures',
  'tui.state.ui': 'ui failures',
  'tui.state.lastSuccess': 'last success',
  'tui.state.lastFailure': 'last failure',
  'tui.state.lastGood': 'last-good',
  'tui.state.rolledBack': 'rolled back at',
  'tui.fail.kind': 'kind',
  'tui.fail.none': 'none',
  'tui.plugin.section': 'dsh-qaq plugin',
  'tui.plugin.mounted': 'mounted',
  'tui.plugin.notMounted': 'not mounted',
  'tui.preflight.ok': 'pre-launch checks passed',
  'tui.preflight.errors': 'pre-launch errors:',
  'tui.launch.cmd': 'launch command',
  'tui.msg.placeholder': '(no action yet — press a key below)',
  'tui.keys': '1 launch   s refresh   b backup   r rollback   R reset   l lang   q quit',
  'tui.menu.launch': 'Launch guard',
  'tui.menu.refresh': 'Refresh',
  'tui.menu.backup': 'Backup',
  'tui.menu.rollback': 'Rollback',
  'tui.menu.reset': 'Reset counters',
  'tui.menu.mount': 'Mount qaq plugin',
  'tui.menu.plugins': 'Plugins',
  'tui.menu.logs': 'Logs',
  'tui.menu.sideload': 'Sideload watch',
  'tui.menu.hot': 'Hot update',
  'tui.menu.update': 'Check for updates (Beta)',
  'tui.menu.lang': 'Language',
  'tui.menu.quit': 'Quit',

  // tui.ts — per-item detail (shown when ◈ selects the menu item)
  'tui.menudetail.launch': 'fresh preflight, rollback + restart (launcher mode)',
  'tui.menudetail.refresh': 're-render the panel (also every ~1s)',
  'tui.menudetail.backup': 'snapshot the profile into the MANUAL backup set (independent of auto)',
  'tui.menudetail.rollback': 'open the backup list — pick an auto or manual backup to restore',
  'tui.menudetail.reset': 'zero the failure counters',
  'tui.menudetail.mount': 'install/mount the dsh-qaq backup plugin',
  'tui.menudetail.plugins': 'install / uninstall / enable / disable DSH plugins',
  'tui.menudetail.logs': 'error / access / host / qaq log viewer',
  'tui.menudetail.sideload': 'run a continuous sideload guard on an external DSH (toggle)',
  'tui.menudetail.hot': 'watch client-plugin bundles for live reload + auto-restart toggles',
  'tui.menudetail.update': 'check GitHub for a newer QAQ; confirm to download (Beta)',
  'tui.menudetail.lang': 'toggle en / zh',
  'tui.menudetail.quit': 'close the dashboard',

  // tui.ts — backup-management sub-screen
  'tui.backups.title': 'Backups · {profile}',
  'tui.backups.autoHeader': 'Auto backups ({n})',
  'tui.backups.manualHeader': 'Manual backups ({n})',
  'tui.backups.none': '(none)',
  'tui.backups.hint': '↑/↓ select · Enter restore · (3 = manual backup) · q back',
  'tui.backups.needSnap': 'no usable snapshot at {dir}',
  'tui.menudetail.backups': 'browse auto/manual backups and restore one',

  // tui.ts — operating modes (launcher vs sideload)
  'tui.mode.idle': 'mode: idle',
  'tui.mode.launcher': 'mode: launcher (supervising dsh web)',
  'tui.mode.sideload': 'mode: sideload (external DSH)',
  'tui.sideload.watchOk': 'watch: external DSH healthy at {url}',
  'tui.sideload.notFound': 'no external DSH to watch (install the dsh-qaq plugin + start DSH first)',
  'tui.sideload.active': 'sideload guard: active',
  'tui.sideload.started': 'sideload guard started — watching {url} every {sec}s (press 9 to stop)',
  'tui.sideload.stopped': 'sideload guard stopped ({url})',
  'tui.sideload.starting': 'starting probe…',
  'tui.sideload.ok': 'healthy',
  'tui.sideload.rolledBack': 'rolled back to last-good',
  'tui.sideload.failed': '{kind} failure',
  'tui.sideload.unknown': 'not yet verified',

  // tui.ts — plugin-management sub-screen
  'tui.plugins.title': 'Plugins · {profile}',
  'tui.plugins.hint': '↑/↓ select · e enable · d disable · u uninstall · i install · / search · [ ] page · q back',
  'tui.plugins.header': 'name  (green=enabled, red=disabled)',
  'tui.plugins.installPrompt': 'Enter the plugin directory path to install (Enter=install, Esc=cancel):',
  'tui.plugins.pathEmpty': 'no path entered',
  'tui.plugins.scanNone': 'no plugin packages found under {path}',
  'tui.plugins.scanFound': 'found {n} plugin(s) under {path} — choose one to install',
  'tui.plugins.scanTitle': 'Installable plugins under the scanned path',
  'tui.plugins.scanHint': '↑/↓ select plugin · Enter install · Esc cancel',
  'tui.plugins.local': ' · (local discovery — still manageable offline)',

  // tui.ts — hot-update panel (plugin hot-reload support)
  'tui.hot.title': 'Hot update · {profile}',
  'tui.hot.hint': '1 watch client bundles · 2 auto-restart on bundle list · 3 auto-restart on dist · q back',
  'tui.hot.row.watch': '[1] watch client-plugin bundles for live reload: {state}',
  'tui.hot.row.bundles': '[2] auto-restart when the bundle list changes: {state}',
  'tui.hot.row.dist': '[3] auto-restart when the web dist changes: {state}',
  'tui.hot.events.none': '(no events)',
  'tui.hot.line': 'watch {watch} · bundle-restart {bundles} · dist-restart {dist}',
  'tui.hot.on': 'on',
  'tui.hot.off': 'off',
  'tui.hot.watchStarted': 'client bundle watch started ({n} plugin(s))',
  'tui.hot.watchStopped': 'client bundle watch stopped',
  'tui.hot.watchNone': 'no enabled client plugins with a built bundle to watch',
  'tui.hot.ev.changed': 'changed: {name}',
  'tui.hot.ev.verified': 'verified: {name}',
  'tui.hot.ev.rollback': 'rolled back: {name} — {detail}',
  'tui.hot.ev.rollback-failed': 'ROLLBACK FAILED: {name} — {detail}',
  'tui.hot.ev.error': 'error: {name} — {detail}',
  'tui.hot.bundlesOnMsg': 'auto-restart on bundle list change: ON',
  'tui.hot.bundlesOffMsg': 'auto-restart on bundle list change: off',
  'tui.hot.distOnMsg': 'auto-restart on web dist change: ON',
  'tui.hot.distOffMsg': 'auto-restart on web dist change: off',
  'tui.hot.restart.needLauncher': 'auto-restart needs launcher mode — press [1] to start the guard first',
  'tui.hot.restart.triggered': '{reason} change detected — supervised restart…',
  'tui.hot.restart.ok': 'restart after {reason} change healthy: {url}',
  'tui.hot.restart.failed': 'restart after {reason} change failed (kind={kind})',
  'tui.hot.verify.applied': '{name} applied live ✔',
  'tui.hot.verify.pending': '{name} written; DSH offline — applies at next boot',
  'tui.hot.verify.failed': '{name} NOT applied: {detail} (old tree still running)',

  // update.ts — version update check (Beta)
  'tui.update.checking': 'Checking for updates…',
  'tui.update.latest': 'Already up to date (v{version})',
  'tui.update.available': 'New version v{latest} found (current v{current}) — press this item again to confirm',
  'tui.update.hasNew': 'new update v{version}',
  'tui.update.failed': 'Update check failed: {error}',
  'tui.update.downloading': 'Downloading v{version} source archive…',
  'tui.update.downloaded': 'Saved to {path} — run `qaq setup` to finish the upgrade',
  'tui.update.downloadFailed': 'Download failed: {error}',

  // env.ts — pre-launch self-check problems
  'env.DSH_NOT_FOUND.msg': 'Cannot find the dsh command and no DeepSeek Harness source checkout was found.',
  'env.DSH_NOT_FOUND.hint': 'Install dsh and put it on PATH, or pass --cwd pointing at the DSH checkout; or set QAQ_DSH_CMD.',
  'env.NO_BROWSER.msg': 'No Chrome / Chromium / Edge found; the UI red-screen probe needs a browser.',
  'env.NO_BROWSER.hint': 'Install Chrome or Edge (either one). QAQ will not touch your browser data.',
  'env.PORT_BUSY.msg': 'Port {port} is already in use.',
  'env.PORT_BUSY.hint': 'A dsh web may already be running. Stop it first, or pick another port with --port.',
  'env.CHECKOUT_INCOMPLETE.msg': 'The directory is not a complete DSH checkout (no CLI entry).',
  'env.CHECKOUT_INCOMPLETE.hint': 'DSH dependencies may be missing or the layout incomplete.',
  'env.banner.error': '[error] ',
  'env.banner.warn': '[warn] ',
  'env.launch.command': 'Launch command: ',
  'env.launch.cwd': 'Working directory: ',
  'env.launch.home': 'DSH data directory: ',
  'env.launch.browser': 'Probe browser: ',
  'env.launch.port': 'Port: ',

  // cli.ts — usage + dsh supervision fatal preflight
  'cli.usage.console': 'open the interactive menu (lazy launcher)',
  'cli.usage.installPlugin': 'auto-mount dsh-qaq backup plugin',
  'cli.fatal.title': 'Pre-launch self-check failed:',
  'cli.fatal.hint': 'Try: qaq console for the interactive console, or set QAQ_DSH_CMD / --cwd.',
  'cli.envFailure': 'Environment/dependency failure — a config rollback cannot fix this: {error}. Check the DSH install, Node version, and permissions, then retry.',

  // install-plugin.ts
  'plugin.already': ' (already mounted)',
  'plugin.notFound': 'dsh-qaq plugin package not found: {dir}',
  'plugin.noName': 'dsh-qaq package.json is missing a name',
  'plugin.noProfile': 'profile {name} is not initialized ({dir}).',
  'plugin.badJson': 'profile package.json is not valid JSON',
  'plugin.staleInsert': 'A stale manual insert row for {name} remains in {profile}/cordis.patch.yml. The bundle mechanism auto-loads this plugin; the leftover row duplicates the entry id and will break the boot - please delete it.',
  'plugin.linkFailed': 'Could not create the node_modules link for {name} ({dir}); manifest write undone, profile untouched.',
  'plugin.linkFailedResult': 'Cannot link dsh-qaq into the profile node_modules ({dir}); this change was reverted. Check permissions and retry.',
  'plugin.writeFailed': 'Failed to write the profile manifest ({path}); reverted.',
  'plugin.writeFailedResult': 'Failed to write the profile manifest ({path}); reverted. Check disk/permissions and retry.',
  'plugin.mountedLog': 'dsh-qaq mounted on profile {name} (bundle layer){already}; the next clean boot writes a last-good snapshot automatically.',
  'plugin.mountedResult': 'Plugin mounted on profile {name} (bundle layer), at: {dir}',

  // plugin-manager.ts
  'pluginMgr.badProfile': 'profile {profile} is not initialized or its manifest is invalid',
  'pluginMgr.badSource': 'source is not a plugin package (no package.json): {source}',
  'pluginMgr.linkFailed': 'could not link plugin module into the profile node_modules: {name}',
  'pluginMgr.alreadyInstalled': 'plugin {name} is already installed',
  'pluginMgr.alreadyEnabled': 'plugin {name} is already enabled',
  'pluginMgr.notInstalled': 'plugin {name} is not installed; install it before enabling',
  'pluginMgr.notBundle': 'plugin {name} is not a DSH bundle (no dsh.bundle) and cannot be added to the profile load list',
  'pluginMgr.notPlugin': 'not a DeepSeek Harness plugin (no dsh.bundle or dsh.client): {name}',
  'pluginMgr.notBundled': 'plugin {name} is not bundled (nothing to disable)',
  'pluginMgr.writeFailed': 'could not write the profile manifest; change reverted',
  'pluginMgr.installed': '✔ installed & enabled plugin {name}',
  'pluginMgr.uninstalled': '✔ uninstalled plugin {name}',
  'pluginMgr.enabled': '✔ enabled plugin {name}',
  'pluginMgr.disabled': '✔ disabled plugin {name}',
  'pluginMgr.empty': 'no plugins found',
  'pluginMgr.count': '{n} plugins',
  'pluginMgr.state.installed': 'installed',
  'pluginMgr.state.enabled': 'enabled',
  'pluginMgr.state.disabled': 'disabled',
  'pluginMgr.state.orphan': 'orphan (module missing)',
  'pluginMgr.state.source': 'installable',

  // dsh-context / TUI — real DSH discovery display
  'tui.dsh.manage': 'managing real DSH: {home}',
  'tui.dsh.checkout': 'checkout: {checkout} ({source})',
  'tui.dsh.checkoutNone': 'no DSH checkout found; install sources limited to already-present modules',
  'tui.dsh.procUp': 'real DSH process: up',
  'tui.dsh.procDown': 'real DSH process: down',
  'tui.dsh.conn.connected': 'dsh-qaq connected',
  'tui.dsh.conn.connecting': 'dsh-qaq connecting',
  'tui.dsh.conn.disconnected': 'dsh-qaq disconnected',
}

/** 简体中文文案。导出以便测试断言与 `en` 的 key 完全一致。 */
export const zh: Record<string, string> = {
  // console.ts — header / menu
  'console.header.title': 'QAQ — DeepSeek Harness 启动容灾守卫控制台',
  'console.menu.title': '主菜单',
  'console.menu.profile': '（profile {name}）',
  'console.menu.1': '一键启动守卫（接管 dsh web）',
  'console.menu.2': '查看状态',
  'console.menu.3': '手动备份当前配置为 last-good',
  'console.menu.4': '手动回滚到 last-good',
  'console.menu.5': '重置失败计数',
  'console.menu.6': '自动挂载 dsh-qaq 备份插件',
  'console.menu.7': '查看日志（error.log / access.log / host.log）',
  'console.menu.q': '退出',
  'console.menu.prompt': '请选择: ',
  'console.menu.unknown': '未知选项，请重试。',
  'console.guard.running': '🛡 守卫监控中：dsh web 正在后台运行（回车 [1] 会被拒绝，等待其退出即可）',
  'console.notice.prefix': '✔ ',

  // console.ts — state / logs
  'console.state.title': '—— 当前守卫状态（profile {name}）——',
  'console.state.noSnapshot': '（尚无快照）',
  'console.logs.none': '（无日志）',
  'console.logs.error': '—— error.log（最近）——',
  'console.logs.access': '—— access.log（最近）——',
  'console.logs.host': '—— host.log（最近）——',
  'console.logs.return': '[回车返回菜单] ',
  'console.notify.exit': '\n[通知] dsh web 已退出 (code={code})，守卫锁已释放。',

  // console.ts — launch flow
  'console.launch.alreadyRunning': '\n[守卫] 已有一个受监督的 dsh web 在运行。返回菜单等待其退出后再启动。',
  'console.launch.preflightError': '\n[错误] 前置检查未通过，无法启动守卫：',
  'console.launch.preflightPass': '\n✅ 前置检查通过',
  'console.launch.preflightSuffix': '，即将启动：',
  'console.launch.confirm': '确认启动并接管 dsh web？',
  'console.launch.cancelled': '已取消。',
  'console.launch.error': '[错误] {msg}',
  'console.launch.ok': '\n✅ dsh web 已健康启动：{url}',
  'console.launch.monitoring': '守卫正在监控。输入回车返回菜单，或直接关闭本窗口结束。',
  'console.launch.rolledBack': '\n[回滚] 已自动回滚到 last-good 配置，正在重启 dsh web…',
  'console.launch.rolledBackOk': '\n✅ 回滚后重启健康：{url}',
  'console.launch.rolledBackFail': '\n[错误] 回滚后仍失败（kind={kind}）。请检查 {dir} 中的坏配置。',
  'console.launch.cancelledRollback': '\n[取消] 你拒绝了回滚，不做自动重启。请检查 {dir}。',
  'console.launch.failed': '\n[失败] 启动失败 kind={kind}：{error}。',
  'console.launch.guardError': '\n[守卫错误] {msg}',

  // console.ts — menu actions
  'console.backup.done': '已备份当前配置为 last-good。',
  'console.restore.noSnapshot': '尚无 last-good 快照可用，请先备份或成功启动一次。',
  'console.restore.confirm': '确认将 profile 回滚到 last-good？',
  'console.restore.done': '已回滚到 last-good。',
  'console.reset.done': '已清零失败计数。',
  'console.exit': '守卫控制台已退出。有问题请查看 {dir} 目录，或查看 README。',

  // tui.ts — 全屏仪表盘标签
  'tui.quit': '退出',
  'tui.lang': '语言',
  'tui.langLabel': '语言：{l}',
  'tui.guard.idle': '守卫：空闲',
  'tui.state.host': '主机失败',
  'tui.state.ui': 'UI 失败',
  'tui.state.lastSuccess': '最近成功',
  'tui.state.lastFailure': '最近失败',
  'tui.state.lastGood': '最近可用',
  'tui.state.rolledBack': '上次回滚',
  'tui.fail.kind': '类型',
  'tui.fail.none': '无',
  'tui.plugin.section': 'dsh-qaq 插件',
  'tui.plugin.mounted': '已挂载',
  'tui.plugin.notMounted': '未挂载',
  'tui.preflight.ok': '启动前自检通过',
  'tui.preflight.errors': '启动前自检错误：',
  'tui.launch.cmd': '启动命令',
  'tui.msg.placeholder': '（尚无操作 — 按下方按键）',
  'tui.keys': '[1]启动  [s]刷新  [b]备份  [r]回滚  [R]重置  [l]语言  [q]退出',
  'tui.menu.launch': '启动守卫',
  'tui.menu.refresh': '刷新',
  'tui.menu.backup': '备份',
  'tui.menu.rollback': '回滚',
  'tui.menu.reset': '重置计数',
  'tui.menu.mount': '挂载 qaq 插件',
  'tui.menu.plugins': '插件',
  'tui.menu.logs': '日志',
  'tui.menu.sideload': '侧载 watch',
  'tui.menu.hot': '热更新',
  'tui.menu.update': '检测更新 (Beta)',
  'tui.menu.lang': '语言',
  'tui.menu.quit': '退出',

  // tui.ts — per-item detail（◈ 选中该项时展示）
  'tui.menudetail.launch': '启动前自检，回滚 + 重启（启动器模式）',
  'tui.menudetail.refresh': '重新渲染面板（同时约每 1 秒自动刷新）',
  'tui.menudetail.backup': '把当前 profile 快照进「手动备份」集（与自动集独立）',
  'tui.menudetail.rollback': '打开备份列表——选一个自动或手动备份还原',
  'tui.menudetail.reset': '清零失败计数',
  'tui.menudetail.mount': '安装/挂载 dsh-qaq 备份插件',
  'tui.menudetail.plugins': '安装 / 卸载 / 停用 / 启用 DSH 插件',
  'tui.menudetail.logs': 'error / access / host / qaq 日志查看器',
  'tui.menudetail.sideload': '对外部启动的 DSH 运行持续侧载守卫（开关切换）',
  'tui.menudetail.hot': '监控 client 插件 bundle 热更 + 自动重启开关',
  'tui.menudetail.update': '从 GitHub 检测新版本；发现更新后再次按本项确认下载（Beta）',
  'tui.menudetail.lang': '切换 en / zh',
  'tui.menudetail.quit': '关闭仪表盘',

  // tui.ts — backup-management sub-screen
  'tui.backups.title': '备份 · {profile}',
  'tui.backups.autoHeader': '自动备份（{n}）',
  'tui.backups.manualHeader': '手动备份（{n}）',
  'tui.backups.none': '（无）',
  'tui.backups.hint': '↑/↓ 选择 · Enter 还原 · (3 = 手动备份) · q 返回',
  'tui.backups.needSnap': '{dir} 处没有可用快照',
  'tui.menudetail.backups': '浏览自动/手动备份并还原其一',

  // tui.ts — operating modes (launcher vs sideload)
  'tui.mode.idle': '模式：空闲',
  'tui.mode.launcher': '模式：启动器（监督 dsh web）',
  'tui.mode.sideload': '模式：侧载（外部 DSH）',
  'tui.sideload.watchOk': 'watch：外部 DSH 健康 {url}',
  'tui.sideload.notFound': '没有可 watch 的外部 DSH（请先安装 dsh-qaq 插件并启动 DSH）',
  'tui.sideload.active': '侧载守卫：运行中',
  'tui.sideload.started': '侧载守卫已启动——每 {sec}s 监视 {url}（再按 9 停止）',
  'tui.sideload.stopped': '侧载守卫已停止（{url}）',
  'tui.sideload.starting': '开始探测…',
  'tui.sideload.ok': '健康',
  'tui.sideload.rolledBack': '已回滚到 last-good',
  'tui.sideload.failed': '{kind} 失败',
  'tui.sideload.unknown': '尚未稳定',

  // tui.ts — plugin-management sub-screen
  'tui.plugins.title': '插件 · {profile}',
  'tui.plugins.hint': '↑/↓ 选择 · e 启用 · d 停用 · u 卸载 · i 安装 · / 搜索 · [ ] 翻页 · q 返回',
  'tui.plugins.header': '名称  （绿=已启用，红=已停用）',
  'tui.plugins.installPrompt': '输入要安装的插件目录路径（回车=安装，Esc=取消）：',
  'tui.plugins.pathEmpty': '未输入路径',
  'tui.plugins.scanNone': '在 {path} 下没有找到插件包',
  'tui.plugins.scanFound': '在 {path} 下找到 {n} 个插件——请选择要安装的',
  'tui.plugins.scanTitle': '扫描路径下的可安装插件',
  'tui.plugins.scanHint': '↑/↓ 选择插件 · 回车安装 · Esc 取消',
  'tui.plugins.local': ' · （本地发现——离线也可管理）',

  // tui.ts — hot-update panel (plugin hot-reload support)
  'tui.hot.title': '热更新 · {profile}',
  'tui.hot.hint': '1 监控 client bundle · 2 bundle 列表变化自动重启 · 3 dist 变化自动重启 · q 返回',
  'tui.hot.row.watch': '[1] 监控 client 插件 bundle 热更：{state}',
  'tui.hot.row.bundles': '[2] bundle 列表变化自动重启：{state}',
  'tui.hot.row.dist': '[3] web dist 变化自动重启：{state}',
  'tui.hot.events.none': '（暂无事件）',
  'tui.hot.line': '热更 {watch} · bundle 重启 {bundles} · dist 重启 {dist}',
  'tui.hot.on': '开',
  'tui.hot.off': '关',
  'tui.hot.watchStarted': '已启动 client bundle 热更监控（{n} 个插件）',
  'tui.hot.watchStopped': '已停止 client bundle 热更监控',
  'tui.hot.watchNone': '没有带已构建 bundle 的已启用 client 插件可监控',
  'tui.hot.ev.changed': '变更：{name}',
  'tui.hot.ev.verified': '已验证：{name}',
  'tui.hot.ev.rollback': '已回滚：{name}——{detail}',
  'tui.hot.ev.rollback-failed': '回滚失败：{name}——{detail}',
  'tui.hot.ev.error': '错误：{name}——{detail}',
  'tui.hot.bundlesOnMsg': 'bundle 列表变化自动重启：开',
  'tui.hot.bundlesOffMsg': 'bundle 列表变化自动重启：关',
  'tui.hot.distOnMsg': 'web dist 变化自动重启：开',
  'tui.hot.distOffMsg': 'web dist 变化自动重启：关',
  'tui.hot.restart.needLauncher': '自动重启需要启动器模式——请先按 [1] 启动守卫',
  'tui.hot.restart.triggered': '检测到 {reason} 变化——受监督重启中…',
  'tui.hot.restart.ok': '{reason} 变化后重启健康：{url}',
  'tui.hot.restart.failed': '{reason} 变化后重启失败（kind={kind}）',
  'tui.hot.verify.applied': '{name} 已热生效 ✔',
  'tui.hot.verify.pending': '{name} 已写入；DSH 离线——重启后生效',
  'tui.hot.verify.failed': '{name} 未生效：{detail}（旧树仍在运行）',

  // update.ts — 版本更新检测（Beta）
  'tui.update.checking': '正在检测更新…',
  'tui.update.latest': '已是最新版本 v{version}',
  'tui.update.available': '发现新版本 v{latest}（当前 v{current}）——再次按本项确认更新',
  'tui.update.hasNew': '有新更新 v{version}',
  'tui.update.failed': '更新检测失败：{error}',
  'tui.update.downloading': '正在下载 v{version} 源码包…',
  'tui.update.downloaded': '已保存到 {path}——运行 `qaq setup` 完成升级',
  'tui.update.downloadFailed': '下载失败：{error}',

  // env.ts — pre-launch self-check problems
  'env.DSH_NOT_FOUND.msg': '找不到 dsh 命令，也没有发现 DeepSeek Harness 源码目录。',
  'env.DSH_NOT_FOUND.hint': '请先安装 dsh 并把启动目录加入 PATH，或指定 --cwd 指向 DSH 源码目录；也可设置 QAQ_DSH_CMD。',
  'env.NO_BROWSER.msg': '没有找到 Chrome / Chromium / Edge，UI 红屏检测需要浏览器。',
  'env.NO_BROWSER.hint': '请安装 Chrome 或 Edge（任选其一）。QAQ 不会改动你的浏览器数据。',
  'env.PORT_BUSY.msg': '端口 {port} 已被占用。',
  'env.PORT_BUSY.hint': '可能已有 dsh web 在运行。请先停掉它，或用 --port 指定其它端口。',
  'env.CHECKOUT_INCOMPLETE.msg': '目录不是完整的 DSH checkout（缺少 CLI 入口）。',
  'env.CHECKOUT_INCOMPLETE.hint': '可能 DSH 依赖未安装或结构不完整。',
  'env.banner.error': '[错误] ',
  'env.banner.warn': '[提醒] ',
  'env.launch.command': '启动命令: ',
  'env.launch.cwd': '工作目录: ',
  'env.launch.home': 'DSH 数据目录: ',
  'env.launch.browser': '检测用浏览器: ',
  'env.launch.port': '端口: ',

  // cli.ts — usage + dsh supervision fatal preflight
  'cli.usage.console': '打开交互式菜单（懒人脚本）',
  'cli.usage.installPlugin': '自动挂载 dsh-qaq 备份插件',
  'cli.fatal.title': '启动前自检未通过：',
  'cli.fatal.hint': '可尝试：qaq console 打开交互式控制台，或设置 QAQ_DSH_CMD / --cwd。',
  'cli.envFailure': '环境/依赖类失败——配置回滚无法修复：{error}。请检查 DSH 安装、Node 版本与权限后重试。',

  // install-plugin.ts
  'plugin.already': '（此前已挂载）',
  'plugin.notFound': '找不到 dsh-qaq 插件包：{dir}',
  'plugin.noName': 'dsh-qaq package.json 缺少 name',
  'plugin.noProfile': 'profile {name} 尚未初始化（目录 {dir}）。',
  'plugin.badJson': 'profile package.json 无法解析',
  'plugin.staleInsert': '检测到 {profile}/cordis.patch.yml 中仍有 {name} 的手动 insert 行。bundle 机制会自动加载该插件，残留行会导致 duplicate entry 启动失败，请手动删除该行。',
  'plugin.linkFailed': '无法建立 node_modules 链接：{name}（{dir}）；已撤销 manifest 写入，profile 未受影响。',
  'plugin.linkFailedResult': '无法将 dsh-qaq 链接进 profile 的 node_modules（{dir}），已撤销本次修改。请检查权限后重试。',
  'plugin.writeFailed': '写入 profile manifest 失败，已回滚原始内容：{name}',
  'plugin.writeFailedResult': '写入 profile manifest 失败（{path}），已回滚。请检查磁盘/权限后重试。',
  'plugin.mountedLog': 'dsh-qaq 插件已挂载到 profile {name}（bundle layer）{already}；下次干净启动会自动写 last-good 快照。',
  'plugin.mountedResult': '插件已挂载到 profile {name}（bundle layer），目录：{dir}',

  // plugin-manager.ts
  'pluginMgr.badProfile': 'profile {profile} 尚未初始化或 manifest 无效',
  'pluginMgr.badSource': '源目录不是插件包（缺少 package.json）：{source}',
  'pluginMgr.linkFailed': '无法将插件模块链接进 profile 的 node_modules：{name}',
  'pluginMgr.alreadyInstalled': '插件 {name} 已安装',
  'pluginMgr.alreadyEnabled': '插件 {name} 已启用',
  'pluginMgr.notInstalled': '插件 {name} 未安装，请先安装再启用',
  'pluginMgr.notBundle': '插件 {name} 不是 DSH bundle（没有 dsh.bundle），不能加入 profile 加载列表',
  'pluginMgr.notPlugin': '不是 DeepSeek Harness 插件（无 dsh.bundle 或 dsh.client）：{name}',
  'pluginMgr.notBundled': '插件 {name} 未在 bundle 列表（无需停用）',
  'pluginMgr.writeFailed': '写入 profile manifest 失败，本次修改已撤销',
  'pluginMgr.installed': '✔ 已安装并启用插件 {name}，重启后生效',
  'pluginMgr.uninstalled': '✔ 已卸载插件 {name}',
  'pluginMgr.enabled': '✔ 已启用插件 {name}，重启后生效',
  'pluginMgr.disabled': '✔ 已停用插件 {name}，重启后生效',
  'pluginMgr.empty': '没有任何插件',
  'pluginMgr.count': '共 {n} 个插件',
  'pluginMgr.state.installed': '已安装',
  'pluginMgr.state.enabled': '已启用',
  'pluginMgr.state.disabled': '已停用',
  'pluginMgr.state.orphan': '孤儿（模块缺失）',
  'pluginMgr.state.source': '可安装',

  // dsh-context / TUI — real DSH discovery display
  'tui.dsh.manage': '管理真实 DSH：{home}',
  'tui.dsh.checkout': 'checkout：{checkout}（{source}）',
  'tui.dsh.checkoutNone': '未找到 DSH checkout，安装源仅限已存在的模块',
  'tui.dsh.procUp': '真实 DSH 进程：在线',
  'tui.dsh.procDown': '真实 DSH 进程：离线',
  'tui.dsh.conn.connected': 'dsh-qaq 已连接',
  'tui.dsh.conn.connecting': 'dsh-qaq 连接中',
  'tui.dsh.conn.disconnected': 'dsh-qaq 未连接',
}

export function makeT(lang: Lang): T {
  const dict = lang === 'en' ? en : zh
  return (key, vars) => {
    let s = dict[key]
    if (s === undefined) s = key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v))
    }
    return s
  }
}
