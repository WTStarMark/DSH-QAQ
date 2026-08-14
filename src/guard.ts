/**
 * The guard orchestration for one 'dsh web' lifecycle. The web server is a
 * long-lived GUI: for qaq dsh web the guard spawns it, wait for host+UI health,
 * snapshots last-good on success, and otherwise drives failure counting +
 * rollback + a single post-rollback restart (both gated by the anti-loop fence).
 */
import { spawnDsh, type DshSupervisor } from './spawn-dsh.ts'
import { detectUi } from './detector-ui.ts'
import { readState, writeState, profileState, acquireLock } from './store.ts'
import { maybeRollback, recordSuccess } from './rollback.ts'
import { resolveDshHome, profileDir, qaqDir } from './paths.ts'
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
}

export interface BootFailure {
  ok: false
  failureKind: 'host' | 'ui' | 'unknown'
  error?: string
  rolledBack: boolean
}

export interface BootHealthy {
  ok: true
  /** The live supervised process, still running, for the caller to await. */
  supervisor: DshSupervisor
  url: string
}

export type BootVerdict = BootHealthy | BootFailure

/**
 * Supervise one dsh web boot to health OR settle a failure (count + rollback).
 * On failure the child is killed and rollback decided; on success the child is
 * left running and returned in the verdict.
 */
export async function superviseBoot(opts: GuardOptions): Promise<BootVerdict> {
  const home = opts.home ?? resolveDshHome()
  const profile = opts.profile ?? 'web'
  const port = opts.port ?? 3080
  const log = new Logger(home)
  const url = 'http://127.0.0.1:' + port
  const dshEnv = { ...opts.dshEnv, DSH_HOME: home }

  // Ensure the dsh command listens on the guard's chosen port: append --port when absent.
  const command = ensurePortFlag(opts.command, port)
  const supervision = spawnDsh({
    command, cwd: opts.cwd, env: dshEnv,
    port, portTimeoutMs: opts.portTimeoutMs ?? 30000,
  })

  let hostReady = false
  let hostError: string | undefined
  try { hostReady = await supervision.ready } catch (err) { hostError = String(err instanceof Error ? err.message : err) }

  if (!hostReady) {
    const code = await Promise.race([supervision.exit, sleep(1500), Promise.resolve(undefined)]).catch(() => undefined) as (number | null | undefined)
    const detail = hostError ?? ('host not ready on port ' + port)
    log.error('host boot failed: ' + detail + (code === undefined ? '' : ' exit=' + code))
    supervision.kill()
    incrementFailure(home, profile, 'host', detail, log)
    const rolled = await maybeRollback({ home, profile, kind: 'host', autoConfirm: opts.autoConfirm ?? false, log })
    return { ok: false, failureKind: 'host', error: detail, rolledBack: rolled.triggered }
  }

  // Host ready; L3 UI check.
  let ui
  try { ui = await detectUi(url, opts.uiTimeoutMs ?? 25000) }
  catch (err) {
    const m = String(err instanceof Error ? err.message : err)
    log.error('UI detector failed: ' + m)
    return { ok: false, failureKind: 'unknown', error: m, rolledBack: false }
  }

  if (ui.kind === 'failed') {
    const detail = ui.failureDetail ?? 'Failed to load plugins'
    log.error('UI red screen: ' + detail)
    supervision.kill()
    incrementFailure(home, profile, 'ui', ui.bodyText, log)
    const rolled = await maybeRollback({ home, profile, kind: 'ui', autoConfirm: opts.autoConfirm ?? false, log })
    return { ok: false, failureKind: 'ui', error: detail, rolledBack: rolled.triggered }
  }

  if (ui.kind !== 'ok') {
    // Settled neither healthy nor failed (e.g. never settled). Not a red screen.
    log.warn('UI did not settle (kind=' + ui.kind + '); leaving process running as unknown.')
    return { ok: false, failureKind: 'unknown', error: 'UI unsettled (' + ui.kind + ')', rolledBack: false }
  }

  // Healthy: confirm stable, snapshot success, and hand the live child to caller.
  log.info('host + UI healthy; confirming for ' + (opts.confirmGoodMs ?? 20000) + 'ms')
  await sleep(opts.confirmGoodMs ?? 20000)
  recordSuccess(home, profile, log, join(profileDir(home, profile), 'package.json'), join(profileDir(home, profile), 'cordis.patch.yml'))
  return { ok: true, supervisor: supervision, url }
}

function ensurePortFlag(cmd: string[], port: number): string[] {
  if (cmd.some(a => a === '--port')) return cmd
  return [...cmd, '--port', String(port)]
}

function incrementFailure(home: string, profile: string, kind: 'host' | 'ui', error: string, log: Logger): void {
  const state = readState(home)
  const prof = profileState(state, profile)
  if (kind === 'host') { prof.hostFailures += 1; prof.uiFailures = 0 } else { prof.uiFailures += 1; prof.hostFailures = 0 }
  prof.lastFailure = { kind, ts: new Date().toISOString(), error }
  writeState(home, state)
  log.info(profile + ' ' + kind + 'F=' + (kind === 'host' ? prof.hostFailures : prof.uiFailures))
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }