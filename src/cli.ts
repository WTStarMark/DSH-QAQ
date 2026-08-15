/**
 * qaq CLI entry (ESM, runs via tsx or esbuild-bundled dist).
 * Command surface:
 *   qaq dsh web [--port N] [--yes]              supervise dsh web (detect, rollback, restart)
 *   qaq status                                   show state.json
 *   qaq backup [--profile web]                   snapshot current profile as last-good
 *   qaq restore --to <snapDir> [--profile web]   restore a profile from a snapshot dir
 *   qaq reset --profile web                      zero the failure counters
 */
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readState, writeState, profileState, acquireLock } from './store.ts'
import { resolveDshHome, qaqDir, profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import { maybeRollback, manualBackup, manualRestore, isUsable } from './rollback.ts'

interface CliArgs {
  mode: 'dsh' | 'status' | 'backup' | 'restore' | 'reset' | 'help'
  profile: string
  port?: number
  yes: boolean
  restoreTo?: string
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
  cwd?: string
}

const USAGE = `
qaq — DeepSeek Harness launch resilience guard
Usage:
  qaq dsh web [--port N] [--yes] [opts]     supervise 'dsh web' (host/UI detect, rollback, restart)
  qaq status                                show the guard state
  qaq backup [--profile <name>]            snapshot the current profile as last-good
  qaq restore --to <snapDir> [--profile <name>]  restore a profile from a snapshot dir
  qaq reset --profile <name>               zero the failure counters
Globals:
  --yes                                     auto-confirm rollbacks
dsh web options:
  --confirm-ms <ms>    stable-healthy confirmation window before snapshot (default 20000)
  --ui-timeout <ms>    max wait for the UI to settle during the L3 probe (default 25000)
  --threshold <n>      consecutive failures that trigger a rollback (default 3)
  --cwd <dir>          working directory for the supervised dsh (default: this process cwd)
`

function parseCli(argv: string[]): CliArgs {
  const yes = argv.includes('--yes')
  const rest = argv.filter(a => a !== '--yes')
  const first = rest[0]
  const val = (flag: string): string | undefined => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined }
  const num = (flag: string): number | undefined => { const s = val(flag); return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined }
  const port = num('--port')
  const confirmMs = num('--confirm-ms')
  const uiTimeoutMs = num('--ui-timeout')
  const threshold = num('--threshold')
  const cwd = val('--cwd')

  const base = { yes, port, confirmMs, uiTimeoutMs, threshold, cwd }
  if (first === 'status') return { mode: 'status', profile: val('--profile') ?? 'web', ...base }
  if (first === 'backup') return { mode: 'backup', profile: val('--profile') ?? 'web', ...base }
  if (first === 'restore') return { mode: 'restore', profile: val('--profile') ?? 'web', restoreTo: val('--to'), ...base }
  if (first === 'reset') return { mode: 'reset', profile: val('--profile') ?? 'web', ...base }
  if (first === 'help' || first === '-h' || first === '--help') return { mode: 'help', profile: 'web', ...base }
  // 'dsh', 'web', or bare => dsh supervision.
  return { mode: 'dsh', profile: 'web', ...base }
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2))
  switch (args.mode) {
    case 'help': process.stdout.write(USAGE); return
    case 'status': return cmdStatus(args.profile)
    case 'backup': return cmdBackup(args.profile)
    case 'restore':
      if (!args.restoreTo) { process.stderr.write('[qaq] --to <snapDir> is required for restore\n'); return }
      return cmdRestore(args.profile, args.restoreTo)
    case 'reset': return cmdReset(args.profile)
    case 'dsh': return cmdDsh(args)
  }
}

function cmdStatus(profile: string): void {
  const home = resolveDshHome()
  const state = readState(home)
  const p = state.profiles[profile]
  process.stdout.write(JSON.stringify({
    home: qaqDir(home), config: state.config,
    profile, hostFailures: p?.hostFailures ?? 0, uiFailures: p?.uiFailures ?? 0,
    lastSuccess: p?.lastSuccess ?? null, lastFailure: p?.lastFailure ?? null,
    lastGoodSnapshot: p?.lastGoodSnapshot ?? null, rolledBackAt: p?.rolledBackAt ?? null,
  }, null, 2) + '\n')
}

function cmdBackup(profile: string): void {
  const home = resolveDshHome(); const log = new Logger(home)
  const pr = profileDir(home, profile)
  if (!existsSync(join(pr, 'package.json'))) { log.error('profile not initialized at ' + pr); return }
  manualBackup(home, profile, log)
}

function cmdRestore(profile: string, snapDir: string): void {
  const home = resolveDshHome(); const log = new Logger(home)
  const full = resolve(snapDir)
  if (!isUsable(full)) { log.error('not a snapshot dir (no package.json): ' + full); return }
  manualRestore(home, profile, full, log)
}

function cmdReset(profile: string): void {
  const home = resolveDshHome(); const log = new Logger(home)
  const state = readState(home); const p = profileState(state, profile)
  p.hostFailures = 0; p.uiFailures = 0; delete p.lastFailure
  writeState(home, state); log.info('reset counters for profile ' + profile)
}

async function cmdDsh(args: CliArgs): Promise<void> {
  const home = resolveDshHome(); const log = new Logger(home)
  const port = args.port ?? 3080
  let release
  try { release = acquireLock(home) } catch (e) { log.error(String(e instanceof Error ? e.message : e)); return }

  const command = process.env.QAQ_DSH_CMD
    ? process.env.QAQ_DSH_CMD.split(' ').filter(Boolean)
    : ['dsh', 'web']
  const dshEnv: Record<string, string | undefined> = {}

  const guardOpts: GuardOptions = {
    home, profile: args.profile, command, cwd: args.cwd ?? process.cwd(), port,
    dshEnv, autoConfirm: args.yes,
    retries: 1,
    confirmGoodMs: args.confirmMs,
    uiTimeoutMs: args.uiTimeoutMs,
    threshold: args.threshold,
  }

  try {
    const verdict = await superviseBoot(guardOpts)

    // Healthy: keep the supervised dsh running (the visible GUI). Await the process.
    if (verdict.ok) {
      log.info('dsh web healthy at ' + verdict.url + '. Guard is monitoring; close the window to stop.')
      const code = await verdict.supervisor.exit
      log.info('dsh web exited (code ' + code + '). Guard exiting.')
      return
    }

    // Failed: if a rollback was applied, restart once and monitor the restart.
    if (verdict.rolledBack) {
      log.warn('rollback applied; restarting dsh web once…')
      const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
      if (second.ok) {
        log.info('post-rollback restart healthy at ' + second.url + '. Guard monitoring.')
        await second.supervisor.exit
        return
      }
      log.error('post-rollback restart still failing (kind=' + second.failureKind + '). Stopping to avoid a rollback loop. Inspect ' + join(qaqDir(home), 'rolled-back') + ' and fix config.')
      return
    }

    // Failed: the user declined the rollback at the confirmation prompt. Do not
    // restart (an auto-confirmed restart would bypass their explicit refusal).
    if (verdict.rollbackCancelled) {
      log.warn('rollback cancelled by user. Stopping without auto-restart. Inspect ' + join(qaqDir(home), 'rolled-back') + ' and fix config.')
      return
    }

    // Failed, no rollback (e.g. no last-good yet, or anti-loop fence active).
    log.warn('boot failed (kind=' + verdict.failureKind + (verdict.error ? '; ' + verdict.error : '') + '). Not auto-restarting.')
  } catch (err) {
    log.error('guard error: ' + String(err instanceof Error ? err.message : err))
  } finally {
    release?.()
  }
}

main().catch((err) => { process.stderr.write('[qaq][fatal] ' + (err instanceof Error ? err.message : String(err)) + '\n'); process.exit(1) })