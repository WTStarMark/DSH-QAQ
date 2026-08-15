/**
 * Minimal in-process i18n for the guard's user-facing surface (console UI,
 * pre-launch preflight text, install-plugin results). Two locales — `en` and
 * `zh`. The launchers pin the locale: `bin\qaq-web.cmd` forces `en`,
 * `bin\qaq-web.zh.cmd` forces `zh`; a bare `qaq ...` defaults to `zh` (the
 * original behavior) unless `--lang en` or `$QAQ_LANG=en` says otherwise.
 *
 * Keys are dot-namespaced by area (console.*, env.*, cli.*, plugin.*). Values
 * support `{name}`-style interpolation.
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

const en: Record<string, string> = {
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
}

const zh: Record<string, string> = {
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
