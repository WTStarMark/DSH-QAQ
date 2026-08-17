/**
 * The guard orchestration for one 'dsh web' lifecycle. The web server is a
 * long-lived GUI: for qaq dsh web the guard spawns it, wait for host+UI health,
 * snapshots last-good on success, and otherwise drives failure counting +
 * rollback + a single post-rollback restart (both gated by the anti-loop fence).
 *
 * Transient-failure tolerance: a boot is retried up to `retries` times before it
 * is finally counted as a genuine failure, so one-off Windows flakes (e.g.
 * EBUSY on a config watcher mid-boot, or a client bundle script that transiently
 * fails to load) resolve on their own instead of advancing the strike counter.
 */
import { spawnDsh, type DshSupervisor } from './spawn-dsh.ts'
import { detectUi } from './detector-ui.ts'
import { readState, writeState, profileState } from './store.ts'
import { maybeRollback, recordSuccess } from './rollback.ts'
import { resolveDshHome, profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { join } from 'node:path'
export interface GuardOptions {
  home?: string
  profile?: string
  command: string[]
  cwd: string
  port?: number
  dshEnv?: Record<string, string | undefined>
  autoConfirm?: boolean
  uiTimeoutMs?: number
  portTimeoutMs?: number
  confirmGoodMs?: number
  /** Extra boot retries tolerated before a transient failure is counted. Default 0 (probe sets 1). */
  retries?: number
  /** Consecutive same-kind failures that trigger a rollback (default 3). */
  threshold?: number
}

export interface BootFailure {
  ok: false
  failureKind: 'host' | 'ui' | 'unknown'
  error?: string
  /** True only when a rollback was actually applied (config restored to last-good). */
  rolledBack: boolean
  /** True when the user declined a rollback at the confirmation prompt. */
  rollbackCancelled?: boolean
  /** True when every tolerance retry was also still failing (the last attempt). */
  retriesExhausted: boolean
}

export interface BootHealthy {
  ok: true
  /** The live supervised process, still running, for the caller to await. */
  supervisor: DshSupervisor
  url: string
}

export type BootVerdict = BootHealthy | BootFailure

/** One unattributed boot attempt: returns a raw verdict WITHOUT counting/rollback.
 * `definitive` is set on a host failure where the child died with a fail-loud
 * boot marker (a deterministic config error — retrying cannot help). */
type AttemptResult = { kind: 'host' | 'ui' | 'unknown'; error: string; killed: boolean; definitive?: boolean } | { kind: 'ok'; error: string; supervisor: DshSupervisor }
async function bootAttempt(opts: GuardOptions, command: string[], port: number): Promise<AttemptResult> {
  const home = opts.home ?? resolveDshHome()
  const url = 'http://127.0.0.1:' + port
  const dshEnv = { ...opts.dshEnv, DSH_HOME: home }

  const log = new Logger(home)
  const supervision = spawnDsh({
    command, cwd: opts.cwd, env: dshEnv, port, portTimeoutMs: opts.portTimeoutMs ?? 30000,
    // Capture child output: pipe it into host.log (and mirror to the visible window).
    attachStdio: false,
    onOutput: (chunk, stream) => log.host(chunk, stream),
  })

  let hostReady = false
  let hostError: string | undefined
  try { hostReady = await supervision.ready } catch (err) { hostError = String(err instanceof Error ? err.message : err) }

  if (!hostReady) {
    // Wait up to 1.5s for an exit code so the failure detail can name it.
    const code = await Promise.race([supervision.exit, sleep(1500)]) as (number | null | undefined)
    supervision.kill()
    const detail = hostError ?? ('host not ready on port ' + port)
    return { kind: 'host', error: detail + (code === undefined ? '' : ' exit=' + code), killed: true, definitive: supervision.hasHostFailureMarker() }
  }

  let ui
  try { ui = await detectUi(url, opts.uiTimeoutMs ?? 25000) }
  catch (err) {
    supervision.kill()
    return { kind: 'unknown', error: 'UI detector failed: ' + String(err instanceof Error ? err.message : err), killed: true }
  }

  if (ui.kind === 'failed') {
    // A crashed host can still leave a served page that renders the red screen:
    // the server bound the port, served the HTML shell + JS bundle, and THEN died
    // on the plugin tree. So a red screen alone must not mask a host death —
    // check the child's liveness here too, or the crash is counted as a UI
    // failure and the rollback decision ignores the dead process.
    if (supervision.child.exitCode !== null || supervision.hasHostFailureMarker()) {
      const marker = supervision.hasHostFailureMarker() ? '; fail-loud marker in output' : ''
      const code = supervision.child.exitCode
      supervision.kill()
      return { kind: 'host', error: 'host exited with UI red screen (code=' + code + ')' + marker, killed: true, definitive: supervision.hasHostFailureMarker() }
    }
    supervision.kill()
    return { kind: 'ui', error: ui.failureDetail ?? 'Failed to load plugins', killed: true, definitive: ui.definitive ?? false }
  }
  if (ui.kind !== 'ok') {
    // The host may have bound the port and THEN crashed (a boot-stage error
    // after the server starts). The readiness probe already resolved, so the
    // exit path never ran — check the child's liveness and fail-loud markers
    // here, or this crash would be misclassified as an unknown UI timeout and
    // never counted toward a rollback.
    if (supervision.child.exitCode !== null || supervision.hasHostFailureMarker()) {
      const marker = supervision.hasHostFailureMarker() ? '; fail-loud marker in output' : ''
      const code = supervision.child.exitCode
      supervision.kill()
      return { kind: 'host', error: 'host exited during UI probe (code=' + code + ')' + marker, killed: true, definitive: supervision.hasHostFailureMarker() }
    }
    // Neither healthy nor failed within the UI timeout. Always kill: a live child
    // left behind would hold the port during a retry (EADDRINUSE) and would keep
    // this guard's event loop alive, hanging the process after a reported failure.
    supervision.kill()
    return { kind: 'unknown', error: 'UI did not settle (kind=' + ui.kind + ')', killed: true }
  }

  // Healthy: confirm stable, snapshot success, and hand the live child to caller.
  return { kind: 'ok', error: '', supervisor: supervision }
}

/** Whether a boot failure looks transient (retriable) rather than a genuine misconfiguration. */
function isTransient(attempt: { kind: string; error: string; definitive?: boolean }): boolean {
  // A host that died with a fail-loud boot marker (plugin tree failed to load)
  // is deterministic — a retry can only reproduce it, so count it immediately.
  if (attempt.definitive) return false
  if (attempt.kind === 'host') return true // host-not-ready / early exit is typically a flake or env issue; retry once
  if (attempt.kind === 'unknown') return true
  // A bundle-load "did not activate" that is NOT a service-inject pending is a load flake.
  const e = attempt.error
  if (/bundle script .* failed to load/.test(e)) return true
  if (/import failed/.test(e)) return true
  return false
}

/**
 * Supervise dsh web to health (count + rollback only after tolerance retries are
 * exhausted). On success the child is left running and returned in the verdict.
 */
export async function superviseBoot(opts: GuardOptions): Promise<BootVerdict> {
  const home = opts.home ?? resolveDshHome()
  const profile = opts.profile ?? 'web'
  const log = new Logger(home)
  const retries = opts.retries ?? 0
  // The authoritative port + command are resolved once here. A --port <value>
  // already present in the command is authoritative (it is what the spawned
  // process will actually bind); otherwise opts.port (or 3080) is used and
  // appended to the command. Probe and spawn both use the SAME port, so a
  // command-flags vs bootOption mismatch can never probe the wrong port.
  const target = resolveBootTarget(opts)
  const url = 'http://127.0.0.1:' + target.port

  let last: AttemptResult | null = null
  let exhausted = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await bootAttempt(opts, target.command, target.port)
    if (last.kind === 'ok') {
      // Healthy: confirm the boot stays stable for the window, then re-probe the
      // real DOM once before snapshotting, so a boot that degrades right after
      // the first healthy probe is never recorded as last-good.
      const confirmed = await confirmStable(last.supervisor!, url, opts, log)
      if (confirmed.ok) {
        recordSuccess(home, profile, log, join(profileDir(home, profile), 'package.json'), join(profileDir(home, profile), 'cordis.patch.yml'))
        return { ok: true, supervisor: last.supervisor!, url }
      }
      // The boot did not stay healthy during the confirmation window — treat
      // this attempt as a failure and continue (retry or count). A host death
      // here with a fail-loud marker is just as definitive as in bootAttempt.
      last.supervisor!.kill()
      last = { kind: confirmed.kind, error: confirmed.error, killed: true, definitive: confirmed.kind === 'host' && last.supervisor!.hasHostFailureMarker() }
    }
    if (attempt < retries && isTransient(last)) {
      log.warn('transient boot failure (kind=' + last.kind + '): ' + last.error + '; retrying (' + (retries - attempt) + ' left)')
      continue
    }
    exhausted = attempt >= retries // we broke out because every tolerance retry was used
    break // genuine failure, or retries exhausted
  }
  if (!last) last = { kind: 'unknown', error: 'no boot attempted', killed: true }

  // Count the failure and decide rollback.
  const lastOk = last as Exclude<AttemptResult, { kind: 'ok' }>
  const kind = lastOk.kind === 'ui' ? 'ui' : lastOk.kind === 'host' ? 'host' : 'unknown'
  log.error((kind === 'ui' ? 'UI red screen: ' : 'boot failed: ') + lastOk.error)
  if (kind === 'host' || kind === 'ui') {
    incrementFailure(home, profile, kind, lastOk.error, log)
    // A definitive failure — a host process that died with a fail-loud boot
    // marker, OR a UI red screen that is a deterministic config error ("1 entry
    // did not activate … waiting for service") — is assumed to reproduce on
    // every boot, so roll back on the first hit instead of waiting out the
    // general same-kind threshold.
    const effectiveThreshold = lastOk.definitive ? 1 : opts.threshold
    const rolled = await maybeRollback({ home, profile, kind, autoConfirm: opts.autoConfirm ?? false, log, threshold: effectiveThreshold })
    return {
      ok: false, failureKind: kind, error: lastOk.error,
      rolledBack: rolled.restored, rollbackCancelled: rolled.cancelled,
      retriesExhausted: exhausted,
    }
  }
  return { ok: false, failureKind: 'unknown', error: lastOk.error, rolledBack: false, retriesExhausted: exhausted }
}

/** Confirm a healthy boot stays healthy for `confirmGoodMs`, then re-probe the UI once. */
async function confirmStable(supervisor: DshSupervisor, url: string, opts: GuardOptions, log: Logger): Promise<{ ok: true } | { ok: false; kind: 'host' | 'ui' | 'unknown'; error: string }> {
  const confirmMs = opts.confirmGoodMs ?? 20000
  log.info('host + UI healthy; confirming for ' + confirmMs + 'ms')
  await sleep(confirmMs)
  if (supervisor.child.exitCode !== null) {
    const marker = supervisor.hasHostFailureMarker() ? '; fail-loud marker in output' : ''
    return { ok: false, kind: 'host', error: 'process exited during confirmation window (code=' + supervisor.child.exitCode + ')' + marker }
  }
  // Re-probe the real DOM to verify the UI is still healthy (stable, no red screen).
  // Clamp the probe budget to >= 1ms: a 0 confirm window must still re-read the DOM once.
  try {
    const recheck = await detectUi(url, Math.max(1, Math.min(confirmMs, 15000)))
    if (recheck.kind === 'ok') return { ok: true }
    if (recheck.kind === 'failed') return { ok: false, kind: 'ui', error: recheck.failureDetail ?? 'Failed to load plugins' }
    return { ok: false, kind: 'unknown', error: 'UI did not stay settled during confirmation (kind=' + recheck.kind + ')' }
  } catch (err) {
    return { ok: false, kind: 'unknown', error: 'UI recheck failed: ' + String(err instanceof Error ? err.message : err) }
  }
}

/** Parse the port value from a command that carries an explicit `--port <value>`. */
export function parsePortFrom(cmd: string[]): number | undefined {
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '--port' && cmd[i + 1] !== undefined) {
      const n = Number(cmd[i + 1])
      return Number.isInteger(n) && n > 0 ? n : undefined
    }
  }
  return undefined
}

/**
 * Resolve the authoritative boot target: the command to spawn and the port
 * that both the probe and the spawned process will use. A --port <value>
 * already in the command wins (the spawned process binds it); otherwise
 * opts.port (or 3080) is appended to the command. This keeps probe + spawn
 * on one consistent port.
 */
export function resolveBootTarget(opts: { command: string[]; port?: number }): { command: string[]; port: number } {
  const cmdPort = parsePortFrom(opts.command)
  if (cmdPort !== undefined) return { command: opts.command, port: cmdPort }
  const port = opts.port ?? 3080
  return { command: [...opts.command, '--port', String(port)], port }
}

export function incrementFailure(home: string, profile: string, kind: 'host' | 'ui', error: string, log: Logger): void {
  const state = readState(home)
  const prof = profileState(state, profile)
  if (kind === 'host') { prof.hostFailures += 1; prof.uiFailures = 0 } else { prof.uiFailures += 1; prof.hostFailures = 0 }
  prof.lastFailure = { kind, ts: new Date().toISOString(), error }
  writeState(home, state)
  log.info(profile + ' ' + kind + 'F=' + (kind === 'host' ? prof.hostFailures : prof.uiFailures))
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }