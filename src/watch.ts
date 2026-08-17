/**
 * qaq watch — attach an external QAQ guard to a DSH that someone else launched
 * (desktop / `pnpm dsh web` / a service). Unlike `qaq dsh web` (which spawns and
 * owns the child), `watch` never spawns or kills DSH: it discovers the target
 * from the dsh-qaq plugin heartbeat (or an explicit --attach/--port), probes the
 * real DOM over CDP, counts failures in state.json, and — when the threshold is
 * reached — rolls back to last-good as the CLI decision authority, then fires a
 * webhook. This is the layer that keeps QAQ protective even when it is not the
 * parent of the DSH process.
 *
 * Rollback is always CLI-owned here: the plugin only reports; it never mutates
 * state.json or profile config beyond its own backup snapshot.
 */
import { join } from 'node:path'
import { detectUi } from './detector-ui.ts'
import { detectFailedFibers } from './degraded.ts'
import { incrementFailure } from './guard.ts'
import { maybeRollback, recordSuccess } from './rollback.ts'
import { profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { readPluginHeartbeat, pushEvent, type PluginHeartbeat } from './shared-io.ts'
import { deliverWebhooks } from './webhook.ts'

export interface WatchOptions {
  home: string
  /** Explicit target port; when absent, discovery falls back to the plugin heartbeat. */
  attachPort?: number
  profile: string
  /** Repeatable --webhook URLs. */
  webhooks?: string[]
  /** Consecutive same-kind failures that trigger a rollback (default 3). */
  threshold?: number
  /** True => auto-confirm rollback without prompting. */
  autoConfirm?: boolean
  /** Probe budget for the UI to settle (ms). Default 25000. */
  uiTimeoutMs?: number
  /** When >0, run in a polling loop every N ms instead of once. */
  intervalMs?: number
}

export interface WatchVerdict {
  ok: boolean
  kind: 'ok' | 'host' | 'ui' | 'unknown'
  error?: string
  rolledBack: boolean
  rollbackCancelled?: boolean
  port: number
  source: 'attach' | 'heartbeat' | 'default'
}

/** Resolve the target (port) to watch. Returns null when nothing to watch. */
export function resolveWatchTarget(opts: WatchOptions, log: Logger): { port: number; source: WatchVerdict['source']; hb?: PluginHeartbeat } | null {
  if (opts.attachPort !== undefined && opts.attachPort > 0) {
    return { port: opts.attachPort, source: 'attach' }
  }
  const hb = readPluginHeartbeat(opts.home)
  if (hb?.port && hb.port > 0) {
    log.info('discovered DSH via plugin heartbeat: pid=' + hb.pid + ' port=' + hb.port + ' profile=' + (hb.profile ?? '?'))
    return { port: hb.port, source: 'heartbeat', hb }
  }
  return null
}

/** Perform one supervised-equivalent failure+rollback path for a watched target. */
async function failAndMaybeRollback(opts: WatchOptions, kind: 'host' | 'ui', error: string, logCtx: Logger, definitive = false): Promise<{ restored: boolean; cancelled?: boolean }> {
  incrementFailure(opts.home, opts.profile, kind, error, logCtx)
  // A definitive failure (host fail-loud marker, or a deterministic UI red
  // screen) reproduces every boot, so roll back on the first hit — same as the
  // launcher guard's effective-threshold logic.
  const effectiveThreshold = definitive ? 1 : opts.threshold
  const rolled = await maybeRollback({
    home: opts.home, profile: opts.profile, kind,
    autoConfirm: opts.autoConfirm ?? false, log: logCtx, threshold: effectiveThreshold,
  })
  emitWatchEvents(opts, kind, error, rolled, logCtx)
  return rolled
}

/** One bounded watch pass: probe + count + (maybe) rollback + webhook. */
export async function watchOnce(opts: WatchOptions, log: Logger): Promise<WatchVerdict> {
  const target = resolveWatchTarget(opts, log)
  if (!target) {
    log.warn('no watch target: pass --attach <port>, or start a supervised DSH so the dsh-qaq plugin can report a heartbeat.')
    return { ok: false, kind: 'unknown', error: 'no target', rolledBack: false, port: 0, source: 'default' }
  }
  const url = 'http://127.0.0.1:' + target.port
  const uiTimeout = opts.uiTimeoutMs ?? 25000
  const logCtx = log.in('watch')

  let ui
  try { ui = await detectUi(url, uiTimeout) }
  catch (err) {
    // The target did not serve a bootable page at all => host unreachable.
    const errMsg = String(err instanceof Error ? err.message : err)
    logCtx.error('watch: target unreachable at ' + url + ': ' + errMsg)
    const rolled = await failAndMaybeRollback(opts, 'host', errMsg, logCtx)
    return { ok: false, kind: 'host', error: errMsg, rolledBack: rolled.restored, rollbackCancelled: rolled.cancelled, port: target.port, source: target.source }
  }

  if (ui.kind === 'ok') {
    // Healthy: record success (clears counters + snapshots last-good via the
    // CLI's existing recordSuccess so a foreign boot is also captured).
    recordSuccess(opts.home, opts.profile, logCtx,
      join(profileDir(opts.home, opts.profile), 'package.json'),
      join(profileDir(opts.home, opts.profile), 'cordis.patch.yml'))
    // Non-red-screen degradation advisory: enabled plugins in a failed fiber.
    const degraded = detectFailedFibers(opts.home)
    if (degraded.length) {
      const names = degraded.map((d) => d.name).join(', ')
      logCtx.warn('watch: UI healthy but enabled plugins are in failed fiber state (degraded): ' + names)
      pushEvent(opts.home, 'ui-degraded', opts.profile, { entries: names })
    }
    logCtx.info('watch: healthy at ' + url)
    return { ok: true, kind: 'ok', port: target.port, source: target.source, rolledBack: false }
  }

  if (ui.kind === 'failed') {
    const detail = ui.failureDetail ?? 'Failed to load plugins'
    logCtx.error('watch: UI red screen at ' + url + ': ' + detail)
    const rolled = await failAndMaybeRollback(opts, 'ui', detail, logCtx, ui.definitive ?? false)
    return { ok: false, kind: 'ui', error: detail, rolledBack: rolled.restored, rollbackCancelled: rolled.cancelled, port: target.port, source: target.source }
  }

  // loading / unknown: neither healthy nor failed yet (page still booting).
  logCtx.warn('watch: UI not settled at ' + url + ' (kind=' + ui.kind + ') — treating as unverified, not counting.')
  return { ok: false, kind: 'unknown', error: 'UI not settled (' + ui.kind + ')', rolledBack: false, port: target.port, source: target.source }
}

/** Emit shared events + webhooks for a failed/rolled-back pass. */
function emitWatchEvents(opts: WatchOptions, kind: string, error: string, rolled: { restored: boolean; cancelled?: boolean }, log: Logger): void {
  const data: Record<string, unknown> = { kind, error }
  if (rolled.restored) data.rolledBack = true
  if (rolled.cancelled) data.cancelled = true
  pushEvent(opts.home, 'watch-failed', opts.profile, data)
  // Fire webhook on failure (and always when a rollback happened).
  const ev = { kind: rolled.restored ? 'rollback-applied' : 'boot-failed', ts: new Date().toISOString(), profile: opts.profile, data }
  void deliverWebhooks(opts.home, opts.webhooks ?? [], ev).catch(() => { /* best effort */ })
  log.access((rolled.restored ? 'watch: rollback applied' : 'watch: failed') + ' (' + kind + '): ' + error, data)
}
