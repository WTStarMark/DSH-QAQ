/**
 * qaq-web — a local HTTP + WebSocket GUI for the guard.
 *
 * A long-lived process that serves a static frontend (public/web) and exposes a
 * REST + WS API over the existing QAQ modules. It owns the guard lock + the
 * supervised child (like `qaq tui`), so `qaq web` is a first-class entry:
 *
 *   qaq web [--port N] [--bind 127.0.0.1] [--profile web] [--cwd <dir>]
 *
 * Data plane (read): state.json, snapshots, plugin inventory, logs, shared events.
 * Action plane (write): launch guard, backup/restore/reset, install-plugin,
 *   plugin enable/disable/install/uninstall, sideload watch, hot-update toggles,
 *   update check. All reuse the exact modules the TUI uses — no new business logic.
 *
 * Safety: binds 127.0.0.1 by default (it can roll back config + kill processes).
 * The launch/watch actions hold the same guard lock the console/TUI holds.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { readState, writeState, profileState, listBackups, readSnapshotKind, isUsableSnapshot, acquireLock } from './store.ts'
import { resolveDshHome, qaqDir, profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { manualBackup, manualRestore, isUsable, validateSnapshot } from './rollback.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import { preflight, type EnvReport } from './env.ts'
import { resolveDshContext } from './dsh-context.ts'
import { listPlugins, setPluginEnabled, installPluginModule, uninstallPlugin, discoverPluginSources } from './plugin-manager.ts'
import { readPluginConnection, readEvents, isHeartbeatFresh, pushEvent, readPluginHeartbeat } from './shared-io.ts'
import { installPlugin } from './install-plugin.ts'
import { watchClientBundles, watchRestartTriggers } from './hot-update.ts'
import { resolveLocalVersion, checkForUpdate } from './update.ts'
import { readCheckoutVersion } from './dsh-version.ts'
import { checkDshUpdate } from './dsh-update.ts'
import { isQaqMounted, LOG_TABS, LOG_HEADERS, type LogTab } from './tui.ts'
import { makeT, resolveLang, type Lang, type T } from './i18n.ts'
import type { DshSupervisor } from './spawn-dsh.ts'
import { watchOnce, type WatchVerdict } from './watch.ts'

/** Tunables that flow from the CLI into the web server. */
export interface WebOptions {
  profile?: string
  /** The web GUI's own listen port (default 3090 — distinct from the DSH port). */
  port?: number
  /** Bind host (default 127.0.0.1). */
  host?: string
  /** Working directory for the supervised dsh (source launch). */
  cwd?: string
  lang?: Lang
  /** Override home for tests (else $DSH_HOME / ~/.dsh). */
  home?: string
  yes?: boolean
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
  /** The DSH target port (default 3080). */
  dshPort?: number
}

/** A live supervised guard (lock held). */
interface ActiveGuard { supervisor: DshSupervisor; release: () => void; url: string }
/** A running continuous sideload (external) guard. */
interface SideGuard { timer: ReturnType<typeof setInterval> | null; busy: boolean; url: string; last: string; lastOk: boolean }

/** Mutable server state. */
interface WebState {
  home: string
  profile: string
  cwd?: string
  lang: Lang
  t: T
  port: number
  dshPort: number
  activeGuard: ActiveGuard | null
  sideGuard: SideGuard | null
  hotWatch: { dispose: () => void; count: number } | null
  restartWatch: { dispose: () => void } | null
  autoRestart: { bundles: boolean; dist: boolean }
  hotEvents: string[]
  message: string
  report: EnvReport | null
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
}

const SIDE_GUARD_INTERVAL_MS = 15000

/** Absolute root of the shipped static web assets (public/web), resolved from
 *  this module (src → ../public/web; dist/qaq.mjs → ../public/web). */
function assetRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'web')
}

/** Tail of a log file (newest last), best-effort. */
function readLogTail(path: string, maxLines = 500): string[] {
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return lines.slice(Math.max(0, lines.length - maxLines))
  } catch { return [] }
}

/** Format a backup row: trailing dir name + the ISO ts from its manifest. */
function formatBackupRow(dir: string): { name: string; ts: string | null; kind: 'auto' | 'manual'; usable: boolean } {
  const name = basename(dir)
  let ts: string | null = null
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { ts?: string }
    ts = m.ts ?? null
  } catch { /* keep just the dir name */ }
  return { name, ts, kind: readSnapshotKind(dir), usable: isUsableSnapshot(dir) }
}

/** Refresh the (async) preflight report so status stays live without blocking. */
async function refreshReport(s: WebState): Promise<void> {
  try { s.report = await preflight({ cwd: s.cwd, port: s.dshPort, lang: s.lang }) } catch { s.report = null }
}

/** The current operating mode: launcher (we own a child) / sideload / idle. */
function detectMode(s: WebState): 'idle' | 'launcher' | 'sideload' {
  if (s.activeGuard) return 'launcher'
  if (s.sideGuard && s.sideGuard.timer) return 'sideload'
  return isHeartbeatFresh(s.home) ? 'sideload' : 'idle'
}

/** Live guard status payload (mirrors the TUI status panel, JSON-shaped). */
function buildStatus(s: WebState): Record<string, unknown> {
  const state = readState(s.home)
  const p = profileState(state, s.profile)
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  const conn = ctx.connection
  const mode = detectMode(s)
  const dshCheckout = ctx.checkout
  const dshVersion = dshCheckout ? readCheckoutVersion(dshCheckout) : null
  const version = resolveLocalVersion()
  return {
    home: s.home,
    profile: s.profile,
    profileDir: ctx.profileDir,
    checkout: ctx.checkout ?? null,
    checkoutSource: ctx.checkoutSource ?? 'none',
    processUp: ctx.processUp,
    processPid: ctx.processPid ?? null,
    processPort: ctx.processPort ?? null,
    mode,
    activeGuard: s.activeGuard ? { url: s.activeGuard.url } : null,
    sideGuard: s.sideGuard && s.sideGuard.timer ? { url: s.sideGuard.url, last: s.sideGuard.last, lastOk: s.sideGuard.lastOk } : null,
    conn: { state: conn.state, pid: conn.pid ?? null, port: conn.port ?? null, pluginCount: conn.pluginCount ?? null, settled: conn.settled ?? null },
    mounted: isQaqMounted(s.home, s.profile),
    version,
    dshVersion,
    report: s.report ? {
      command: s.report.command, cwd: s.report.cwd, commandSource: s.report.commandSource,
      browser: s.report.browser ?? null, port: s.report.port, problems: s.report.problems,
    } : null,
    state: {
      hostFailures: p.hostFailures, uiFailures: p.uiFailures,
      lastSuccess: p.lastSuccess ?? null, lastFailure: p.lastFailure ?? null,
      lastGoodSnapshot: p.lastGoodSnapshot ?? null, rolledBackAt: p.rolledBackAt ?? null,
      rollbackEscalation: p.rollbackEscalation ?? null,
    },
    hot: {
      watching: s.hotWatch ? { count: s.hotWatch.count } : null,
      restartWatch: s.restartWatch ? { bundles: s.autoRestart.bundles, dist: s.autoRestart.dist } : null,
      events: s.hotEvents,
    },
    message: s.message,
    server: { port: s.port, host: process.env['QAQ_WEB_HOST'] ?? '127.0.0.1' },
  }
}

/** Backup-management payload: auto + manual groups, newest-first. */
function buildBackups(s: WebState): Record<string, unknown> {
  const auto = listBackups(s.home, 'auto').map(formatBackupRow)
  const manual = listBackups(s.home, 'manual').map(formatBackupRow)
  return { profile: s.profile, auto, manual, lastGood: (() => {
    const state = readState(s.home)
    const p = profileState(state, s.profile)
    if (!p.lastGoodSnapshot) return null
    const ref = p.lastGoodSnapshot.startsWith('history/') ? p.lastGoodSnapshot : 'history/' + p.lastGoodSnapshot
    const dir = join(qaqDir(s.home), ref)
    return { name: basename(dir), ts: p.lastGoodSnapshot, usable: isUsable(dir) && validateSnapshot(dir).ok }
  })() }
}

/** Plugin-manager payload (real DSH plugins), paginated/filtered by the client. */
function buildPlugins(s: WebState, q: URLSearchParams): Record<string, unknown> {
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  const filter = (q.get('filter') ?? '').toLowerCase()
  const plugins = listPlugins({
    profileDir: ctx.profileDir, profile: s.profile, checkout: ctx.checkout, poolDir: ctx.poolDir,
    liveEntries: ctx.liveInventory?.entries,
  }).filter((p) => !filter || shortPluginName(p.name).toLowerCase().includes(filter))
  return {
    profile: s.profile,
    checkout: ctx.checkout ?? null,
    processUp: ctx.processUp, processPid: ctx.processPid ?? null, processPort: ctx.processPort ?? null,
    conn: { state: ctx.connection.state, pid: ctx.connection.pid ?? null, port: ctx.connection.port ?? null, pluginCount: ctx.connection.pluginCount ?? null },
    plugins: plugins.map((p) => ({ name: p.name, short: shortPluginName(p.name), installed: p.installed, enabled: p.enabled, source: p.source ?? null, linkTarget: p.linkTarget ?? null })),
    sources: discoverPluginSources(ctx.checkout).map((s) => ({ name: s.name, dir: s.dir })),
  }
}

/** Log-viewer payload for one tab (with a scroll window, like the TUI). */
function buildLogs(s: WebState, tab: LogTab, scroll: number, maxShown: number): Record<string, unknown> {
  const lines = readLogTail(join(qaqDir(s.home), 'log', LOG_HEADERS[tab]), 500)
  const n = lines.length
  const clamp = Math.max(0, Math.min(scroll, n))
  let to = n - clamp
  let from = Math.max(0, to - maxShown)
  if (to <= 0) { from = 0; to = Math.min(maxShown, n) }
  return { tab, title: LOG_HEADERS[tab], lines: lines.slice(from, to), total: n, scroll: clamp, from, to }
}

/** Short display name: strip the @deepseek-ai/dsh- / dsh- prefix. */
function shortPluginName(name: string): string {
  let s = name
  if (s.startsWith('@deepseek-ai/dsh-')) s = s.slice('@deepseek-ai/dsh-'.length)
  else if (s.startsWith('dsh-')) s = s.slice('dsh-'.length)
  return s || name
}

/** Recent shared events (newest first). */
function buildEvents(s: WebState, limit: number): Record<string, unknown> {
  const events = readEvents(s.home)
  return { events: events.slice(-limit).reverse() }
}

/* ---------------------------------------------------------------------------
 * Action handlers (the same decisions the TUI makes, surfaced over HTTP).
 * ------------------------------------------------------------------------- */

/** Launch (or re-launch) the supervised dsh web. Acquires the guard lock and
 *  keeps the child under this process (mirrors the console's runLaunch). */
async function handleLaunch(s: WebState, log: Logger, yes: boolean): Promise<Record<string, unknown>> {
  if (s.activeGuard) return { ok: false, message: 'guard already running at ' + s.activeGuard.url }
  await refreshReport(s)
  const report = s.report
  if (!report) return { ok: false, message: 'preflight failed' }
  const errors = report.problems.filter((x) => x.sev === 'error')
  if (errors.length) return { ok: false, message: 'preflight failed: ' + errors.map((e) => e.message + ' → ' + e.hint).join('; ') }

  let release: (() => void) | undefined
  try { release = acquireLock(s.home) } catch (e) { return { ok: false, message: 'lock: ' + String(e instanceof Error ? e.message : e) } }

  const guardOpts: GuardOptions = {
    home: s.home, profile: s.profile, command: report.command, cwd: report.cwd, port: s.dshPort,
    dshEnv: {}, autoConfirm: yes, retries: 1,
    confirmGoodMs: s.confirmMs ?? 20000, uiTimeoutMs: s.uiTimeoutMs ?? 25000, threshold: s.threshold ?? 3,
  }
  try {
    const verdict = await superviseBoot(guardOpts)
    if (verdict.ok) {
      s.activeGuard = { supervisor: verdict.supervisor, release: release!, url: verdict.url }
      watchSupervisor(s, log)
      s.message = 'guarding ' + verdict.url
      log.access('web: launched guarded dsh at ' + verdict.url, { profile: s.profile, action: 'web-launch' })
      return { ok: true, url: verdict.url }
    }
    if (verdict.rolledBack) {
      const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
      if (second.ok) {
        s.activeGuard = { supervisor: second.supervisor, release: release!, url: second.url }
        watchSupervisor(s, log)
        s.message = 'rollback applied; guarding ' + second.url
        log.access('web: post-rollback launch healthy at ' + second.url, { profile: s.profile, action: 'web-launch-rollback' })
        return { ok: true, url: second.url, rolledBack: true }
      }
      return { ok: false, message: 'rollback applied but restart still failing (' + second.failureKind + ')', rolledBack: true }
    }
    if (verdict.rollbackCancelled) return { ok: false, message: 'rollback cancelled by user' }
    return { ok: false, message: 'boot failed (' + verdict.failureKind + '): ' + (verdict.error ?? '') }
  } catch (err) {
    return { ok: false, message: 'guard error: ' + String(err instanceof Error ? err.message : err) }
  } finally {
    if (!s.activeGuard) release?.()
  }
}

/** Release the guard lock the moment the supervised child exits. */
function watchSupervisor(s: WebState, log: Logger): void {
  void s.activeGuard?.supervisor.exit.then((code) => {
    const g = s.activeGuard
    s.activeGuard = null
    try { g?.release() } catch { /* best effort */ }
    s.message = 'guarded dsh exited (code ' + String(code ?? '') + ')'
    log.info('web: guarded dsh exited (code ' + String(code ?? '') + ')')
  })
}

/** Stop a supervised child (kill + release lock). */
function handleStop(s: WebState, log: Logger): Record<string, unknown> {
  if (!s.activeGuard) return { ok: false, message: 'no guarded dsh running' }
  const g = s.activeGuard
  s.activeGuard = null
  try { g.supervisor.kill() } catch { /* best effort */ }
  try { g.release() } catch { /* best effort */ }
  s.message = 'stopped guarded dsh'
  log.access('web: stopped guarded dsh', { profile: s.profile, action: 'web-stop' })
  return { ok: true }
}

function handleBackup(s: WebState, log: Logger): Record<string, unknown> {
  manualBackup(s.home, s.profile, log)
  s.message = 'manual backup created'
  return { ok: true, message: 'manual backup created' }
}

function handleRestore(s: WebState, log: Logger, dir: string): Record<string, unknown> {
  const full = resolve(dir)
  if (!isUsable(full)) return { ok: false, message: 'not a snapshot dir (no package.json)' }
  manualRestore(s.home, s.profile, full, log)
  s.message = 'restored from ' + basename(full)
  return { ok: true, message: 'restored from ' + basename(full) }
}

function handleReset(s: WebState, log: Logger): Record<string, unknown> {
  const state = readState(s.home)
  const p = profileState(state, s.profile)
  p.hostFailures = 0; p.uiFailures = 0; delete p.lastFailure
  writeState(s.home, state)
  log.access('reset counters via web for profile ' + s.profile, { profile: s.profile, action: 'reset' })
  s.message = 'counters reset'
  return { ok: true, message: 'counters reset' }
}

function handleInstallPlugin(s: WebState, log: Logger): Record<string, unknown> {
  const r = installPlugin(s.home, s.profile, log, s.lang)
  s.message = r.message
  return { ok: r.ok, message: r.message, mounted: r.mounted }
}

function handlePluginEnable(s: WebState, log: Logger, name: string, enabled: boolean): Record<string, unknown> {
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  const r = setPluginEnabled({ profileDir: ctx.profileDir, profile: s.profile, name, enabled, checkout: ctx.checkout, poolDir: ctx.poolDir }, log, s.lang)
  s.message = r.message
  return { ok: r.ok, message: r.message, mechanism: r.mechanism ?? null }
}

function handlePluginInstall(s: WebState, log: Logger, name: string, source: string): Record<string, unknown> {
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  const r = installPluginModule({ profileDir: ctx.profileDir, profile: s.profile, name, source, poolDir: ctx.poolDir }, log, s.lang)
  s.message = r.message
  return { ok: r.ok, message: r.message, mechanism: r.mechanism ?? null }
}

function handlePluginUninstall(s: WebState, log: Logger, name: string): Record<string, unknown> {
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  const r = uninstallPlugin({ profileDir: ctx.profileDir, profile: s.profile, name, poolDir: ctx.poolDir }, log, s.lang)
  s.message = r.message
  return { ok: r.ok, message: r.message, mechanism: r.mechanism ?? null }
}

/** Toggle the continuous sideload (external) guard. */
function handleWatchToggle(s: WebState, log: Logger): Record<string, unknown> {
  if (s.sideGuard && s.sideGuard.timer) {
    clearInterval(s.sideGuard.timer)
    s.sideGuard.timer = null
    s.message = 'sideload watch stopped'
    log.access('web: sideload watch stopped', { profile: s.profile, action: 'web-watch-stop' })
    return { ok: true, active: false }
  }
  // Resolve the target URL from the heartbeat, else the CLI attach port.
  const hb = readPluginHeartbeat(s.home)
  const port = hb?.port ?? s.dshPort
  const url = 'http://127.0.0.1:' + port
  const sg: SideGuard = { timer: null, busy: false, url, last: 'starting', lastOk: false }
  s.sideGuard = sg
  const tick = async (): Promise<void> => {
    if (sg.busy) return
    sg.busy = true
    try {
      const v = await watchOnce({ home: s.home, profile: s.profile, attachPort: port, threshold: s.threshold ?? 3, autoConfirm: true, uiTimeoutMs: s.uiTimeoutMs ?? 25000 }, log)
      sg.lastOk = v.ok
      sg.last = diagnoseVerdict(v, s.t)
      sg.url = 'http://127.0.0.1:' + v.port
    } catch (err) {
      sg.lastOk = false
      sg.last = 'error: ' + String(err instanceof Error ? err.message : err)
    } finally {
      sg.busy = false
    }
  }
  void tick()
  sg.timer = setInterval(tick, SIDE_GUARD_INTERVAL_MS)
  s.message = 'sideload watch active on ' + url
  log.access('web: sideload watch started on ' + url, { profile: s.profile, action: 'web-watch-start' })
  return { ok: true, active: true, url }
}

/** Diagnose a one-shot watch verdict to a short outcome label. */
function diagnoseVerdict(v: WatchVerdict, t: T): string {
  if (v.ok) return t('tui.sideload.ok')
  if (v.rolledBack) return t('tui.sideload.rolledBack')
  if (v.kind === 'host' || v.kind === 'ui') return t('tui.sideload.failed', { kind: v.kind })
  return v.error ?? t('tui.sideload.unknown')
}

/** Toggle hot-update channel 1 (client bundle watch). */
function handleHotWatch(s: WebState, log: Logger, on: boolean): Record<string, unknown> {
  if (on) {
    if (s.hotWatch) return { ok: true, watching: true }
    const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
    s.hotWatch = { count: 0, dispose: watchClientBundles({
      home: s.home, profile: s.profile, checkout: ctx.checkout, poolDir: ctx.poolDir,
      onEvent: (e) => { pushHotEvent(s, '♨ ' + e.kind + (e.name ? ' ' + e.name : '') + (e.detail ? ' ' + e.detail : '')) },
    }) }
    s.message = 'hot-update client-bundle watch on'
    log.access('web: hot client-bundle watch on', { profile: s.profile, action: 'web-hot-on' })
    return { ok: true, watching: true }
  }
  if (s.hotWatch) { s.hotWatch.dispose(); s.hotWatch = null }
  s.message = 'hot-update client-bundle watch off'
  return { ok: true, watching: false }
}

/** Toggle hot-update channel 3 (restart triggers: bundles list / web dist). */
function handleRestartWatch(s: WebState, log: Logger, bundles: boolean, dist: boolean): Record<string, unknown> {
  if (s.restartWatch) { s.restartWatch.dispose(); s.restartWatch = null }
  s.autoRestart = { bundles, dist }
  if (bundles || dist) {
    const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
    s.restartWatch = { dispose: watchRestartTriggers({
      home: s.home, profile: s.profile, checkout: ctx.checkout, watchBundles: bundles, watchDist: dist,
      onTrigger: (reason) => {
        pushHotEvent(s, '⟳ restart trigger: ' + reason)
        pushEvent(s.home, 'hot-restart-trigger', s.profile, { reason })
      },
    }) }
    s.message = 'hot-update restart watch on (bundles=' + bundles + ', dist=' + dist + ')'
  } else {
    s.message = 'hot-update restart watch off'
  }
  return { ok: true, bundles, dist }
}

function pushHotEvent(s: WebState, text: string): void {
  s.hotEvents.unshift(text)
  if (s.hotEvents.length > 8) s.hotEvents.pop()
}

/** Update check: QAQ (GitHub) + the managed DSH (GitHub tags). */
async function handleUpdateCheck(s: WebState, log: Logger): Promise<Record<string, unknown>> {
  const qaq = await checkForUpdate()
  let dsh: Record<string, unknown> = { ok: true, updateAvailable: false }
  const ctx = resolveDshContext({ profile: s.profile, cwd: s.cwd })
  if (ctx.checkout) {
    const r = await checkDshUpdate({ checkout: ctx.checkout })
    dsh = { ok: r.ok, updateAvailable: r.updateAvailable ?? false, latest: r.latestVersion ?? null, current: r.current ?? null, error: r.error ?? null }
  }
  log.access('web: update check', { profile: s.profile, action: 'web-update-check', qaq: qaq.updateAvailable })
  return { ok: true, qaq: { current: qaq.current, latest: qaq.latest, updateAvailable: qaq.updateAvailable, error: qaq.error ?? null }, dsh }
}

/* ---------------------------------------------------------------------------
 * HTTP plumbing.
 * ------------------------------------------------------------------------- */

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c); if (raw.length > 1e6) { req.destroy(); resolveBody({}) } })
    req.on('end', () => {
      try { resolveBody(JSON.parse(raw || '{}') as Record<string, unknown>) } catch { resolveBody({}) }
    })
    req.on('error', () => resolveBody({}))
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (pathname === '/') pathname = '/index.html'
  const root = assetRoot()
  // Resolve within the asset root; strip any leading traversal.
  const target = resolve(join(root, '.' + pathname))
  if (!target.startsWith(root + '\\') && !target.startsWith(root + '/')) { res.writeHead(403); res.end('forbidden'); return }
  try {
    if (existsSync(target) && statSync(target).isFile()) {
      const ext = extname(target).toLowerCase()
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      res.end(readFileSync(target))
      return
    }
  } catch { /* fall through to 404 */ }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/** Route an HTTP request. Returns true when handled. */
async function route(s: WebState, log: Logger, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const p = url.pathname
  const m = req.method ?? 'GET'
  // CORS for the WS/API origin (the frontend is same-origin, so this is a no-op
  // unless a caller mounts it elsewhere).
  if (m === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); res.end(); return }

  if (p.startsWith('/api/')) {
    if (m === 'GET') {
      if (p === '/api/status') return void json(res, 200, buildStatus(s))
      if (p === '/api/backups') return void json(res, 200, buildBackups(s))
      if (p === '/api/plugins') return void json(res, 200, buildPlugins(s, url.searchParams))
      if (p === '/api/events') return void json(res, 200, buildEvents(s, Number(url.searchParams.get('limit') ?? 50)))
      if (p === '/api/logs') {
        const tab = (url.searchParams.get('tab') ?? 'error') as LogTab
        const valid = LOG_TABS.includes(tab) ? tab : 'error'
        const scroll = Number(url.searchParams.get('scroll') ?? 0) || 0
        const maxShown = Number(url.searchParams.get('max') ?? 60) || 60
        return void json(res, 200, buildLogs(s, valid, scroll, maxShown))
      }
    }
    if (m === 'POST' && p === '/api/action') {
      const body = await readBody(req)
      const action = String(body.action ?? '')
      const yes = body.yes === true
      switch (action) {
        case 'launch': return void json(res, 200, await handleLaunch(s, log, yes))
        case 'stop': return void json(res, 200, handleStop(s, log))
        case 'backup': return void json(res, 200, handleBackup(s, log))
        case 'restore': return void json(res, 200, handleRestore(s, log, String(body.dir ?? '')))
        case 'reset': return void json(res, 200, handleReset(s, log))
        case 'install-plugin': return void json(res, 200, handleInstallPlugin(s, log))
        case 'plugin-enable': return void json(res, 200, handlePluginEnable(s, log, String(body.name ?? ''), body.enabled === true))
        case 'plugin-install': return void json(res, 200, handlePluginInstall(s, log, String(body.name ?? ''), String(body.source ?? '')))
        case 'plugin-uninstall': return void json(res, 200, handlePluginUninstall(s, log, String(body.name ?? '')))
        case 'watch-toggle': return void json(res, 200, handleWatchToggle(s, log))
        case 'hot-watch': return void json(res, 200, handleHotWatch(s, log, body.on === true))
        case 'hot-restart': return void json(res, 200, handleRestartWatch(s, log, body.bundles === true, body.dist === true))
        case 'update-check': return void json(res, 200, await handleUpdateCheck(s, log))
        default: return void json(res, 400, { ok: false, message: 'unknown action: ' + action })
      }
    }
    return void json(res, 404, { ok: false, message: 'not found' })
  }
  serveStatic(req, res)
}

/** Broadcast a payload to every connected WS client. */
function broadcast(wss: WebSocketServer, payload: unknown): void {
  const data = JSON.stringify(payload)
  for (const c of wss.clients) { if (c.readyState === 1) { try { c.send(data) } catch { /* ignore */ } } }
}

/** Start the web GUI server. Resolves with the bound port once listening. */
export async function runWeb(opts: WebOptions = {}): Promise<{ port: number; host: string; close: () => Promise<void> }> {
  const home = resolveDshHome(opts.home ? { DSH_HOME: opts.home } as Record<string, string | undefined> : process.env)
  const profile = opts.profile ?? 'web'
  const lang = opts.lang ?? resolveLang([])
  const t = makeT(lang)
  const log = new Logger(home)
  const port = opts.port ?? 3090
  const host = opts.host ?? '127.0.0.1'

  const s: WebState = {
    home, profile, cwd: opts.cwd, lang, t, port, dshPort: opts.dshPort ?? 3080,
    activeGuard: null, sideGuard: null, hotWatch: null, restartWatch: null,
    autoRestart: { bundles: false, dist: false }, hotEvents: [], message: '',
    report: null,
    confirmMs: opts.confirmMs, uiTimeoutMs: opts.uiTimeoutMs, threshold: opts.threshold,
  }

  await refreshReport(s)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? '127.0.0.1'))
    void route(s, log, req, res, url).catch(() => { try { res.writeHead(500); res.end('server error') } catch { /* ignore */ } })
  })

  const wss = new WebSocketServer({ server, path: '/api/stream' })
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'status', data: buildStatus(s) }))
  })

  // Live broadcast loop (~1s) so the dashboard stays current without polling.
  const push = (): void => {
    const status = buildStatus(s)
    // The status object includes report (may be null); send it as-is.
    broadcast(wss, { type: 'status', data: status })
  }
  const pushTimer = setInterval(() => { try { push() } catch { /* ignore */ } }, 1000)
  pushTimer.unref?.()
  // Refresh the (async) env report every few seconds so the launch summary stays live.
  const reportTimer = setInterval(() => { void refreshReport(s) }, 5000)
  reportTimer.unref?.()

  // Close handlers: release any held guard lock on shutdown.
  const close = async (): Promise<void> => {
    clearInterval(pushTimer)
    clearInterval(reportTimer)
    if (s.sideGuard?.timer) clearInterval(s.sideGuard.timer)
    s.hotWatch?.dispose()
    s.restartWatch?.dispose()
    try { wss.close() } catch { /* ignore */ }
    await new Promise<void>((resClose) => { server.close(() => resClose()) })
    if (s.activeGuard) { try { s.activeGuard.supervisor.kill() } catch { /* ignore */ } try { s.activeGuard.release() } catch { /* ignore */ } }
  }

  await new Promise<void>((resListen, rej) => {
    server.once('error', (e) => rej(e))
    server.listen(port, host, () => resListen())
  })

  log.access('web GUI started on http://' + host + ':' + port, { profile, action: 'web-start', port })
  process.stdout.write('[qaq] web GUI: http://' + host + ':' + port + '  (profile=' + profile + ')\n')

  return { port, host, close }
}
