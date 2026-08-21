/**
 * qaq CLI entry (ESM, runs via tsx or esbuild-bundled dist).
 * Command surface:
 *   qaq dsh web [--port N] [--yes]              supervise dsh web (detect, rollback, restart)
 *   qaq watch [--attach N] [--once] [opts]       attach an external guard to an already-running DSH
 *   qaq status                                   show state.json
 *   qaq backup [--profile web]                   snapshot current profile as last-good
 *   qaq restore --to <snapDir> [--profile web]   restore a profile from a snapshot dir
 *   qaq reset --profile web                      zero the failure counters
 *   qaq setup                                   install deps + build (one-click)
 *   qaq tui / qaq console                        full-screen live dashboard (or fallback menu)
 */
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readState, writeState, profileState, acquireLock } from './store.ts'
import { resolveDshHome, qaqDir, profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import { openConsole } from './console.ts'
import { installPlugin } from './install-plugin.ts'
import { preflight } from './env.ts'
import { manualBackup, manualRestore, isUsable, MAX_ESCALATION_STEPS } from './rollback.ts'
import { watchOnce } from './watch.ts'
import { makeT, resolveLang, type Lang } from './i18n.ts'
import { runSetup } from './setup.ts'

interface CliArgs {
  mode: 'dsh' | 'watch' | 'status' | 'backup' | 'restore' | 'reset' | 'console' | 'install-plugin' | 'setup' | 'help'
  profile: string
  port?: number
  yes: boolean
  restoreTo?: string
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
  cwd?: string
  lang: Lang
  attach?: number
  intervalMs?: number
  once?: boolean
  webhooks?: string[]
}

function usage(lang: Lang): string {
  const t = makeT(lang)
  return `
qaq — DeepSeek Harness launch resilience guard
Usage:
  qaq dsh web [--port N] [--yes] [opts]     supervise 'dsh web' (host/UI detect, rollback, restart)
  qaq watch [--attach N] [--once] [opts]   attach an external guard to an already-running DSH
  qaq status                                show the guard state
  qaq backup [--profile <name>]            snapshot the current profile as last-good
  qaq restore --to <snapDir> [--profile <name>]  restore a profile from a snapshot dir
  qaq reset --profile <name>               zero the failure counters
  qaq console                             ${t('cli.usage.console')}
  qaq install-plugin [--profile <name>]   ${t('cli.usage.installPlugin')}
  qaq setup                                  install deps + build (one-click)
Globals:
  --yes                                     auto-confirm rollbacks
  --lang en|zh                              console/preflight language (default zh; or \$QAQ_LANG)
dsh web options:
  --confirm-ms <ms>    stable-healthy confirmation window before snapshot (default 20000)
  --ui-timeout <ms>    max wait for the UI to settle during the L3 probe (default 25000)
  --threshold <n>      consecutive failures that trigger a rollback (default 3)
  --cwd <dir>          working directory for the supervised dsh (default: this process cwd)
watch options:
  --attach <port>      target port to watch (default: discover from the dsh-qaq plugin heartbeat)
  --once               check once and exit (default; repeat with --interval)
  --interval <ms>      keep polling every N ms until Ctrl+C
  --webhook <url>      webhook URL for failure/rollback events (repeatable; or QAQ_WEBHOOK_URL)
`
}

export function parseCli(argv: string[]): CliArgs {
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
  const attach = num('--attach')
  const intervalMs = num('--interval')
  const once = rest.includes('--once')
  const webhooks: string[] = []
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--webhook' && rest[i + 1] !== undefined) webhooks.push(rest[i + 1]) }
  const lang = resolveLang(rest)

  const base = { yes, port, confirmMs, uiTimeoutMs, threshold, cwd, lang, attach, intervalMs, once, webhooks }
  if (first === 'setup' || first === 'install') return { mode: 'setup', profile: 'web', ...base }
  if (first === 'status') return { mode: 'status', profile: val('--profile') ?? 'web', ...base }
  if (first === 'backup') return { mode: 'backup', profile: val('--profile') ?? 'web', ...base }
  if (first === 'restore') return { mode: 'restore', profile: val('--profile') ?? 'web', restoreTo: val('--to'), ...base }
  if (first === 'reset') return { mode: 'reset', profile: val('--profile') ?? 'web', ...base }
  if (first === 'console' || first === 'menu' || first === 'gui' || first === 'tui') return { mode: 'console', profile: val('--profile') ?? 'web', ...base }
  if (first === 'install-plugin') return { mode: 'install-plugin', profile: val('--profile') ?? 'web', ...base }
  if (first === 'watch') return { mode: 'watch', profile: val('--profile') ?? 'web', ...base, attach: attach ?? port }
  if (first === 'help' || first === '-h' || first === '--help') return { mode: 'help', profile: 'web', ...base }
  // 'dsh', 'web', or bare => dsh supervision.
  return { mode: 'dsh', profile: 'web', ...base }
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2))
  switch (args.mode) {
    case 'help': process.stdout.write(usage(args.lang)); return
    case 'status': return cmdStatus(args.profile)
    case 'backup': return cmdBackup(args.profile)
    case 'restore':
      if (!args.restoreTo) { process.stderr.write('[qaq] --to <snapDir> is required for restore\n'); return }
      return cmdRestore(args.profile, args.restoreTo)
    case 'reset': return cmdReset(args.profile)
    case 'setup': return cmdSetup(args)
    case 'console': return cmdConsole(args)
    case 'install-plugin': return cmdInstallPlugin(args.profile, args.lang)
    case 'watch': return cmdWatch(args)
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
  log.access('reset counters for profile ' + profile, { profile, action: 'reset' })
}

function cmdConsole(args: CliArgs): Promise<void> {
  return openConsole(args.profile, {
    yes: args.yes, port: args.port, cwd: args.cwd,
    confirmMs: args.confirmMs, uiTimeoutMs: args.uiTimeoutMs, threshold: args.threshold,
    lang: args.lang,
  })
}

function cmdInstallPlugin(profile: string, lang: Lang): void {
  const home = resolveDshHome(); const log = new Logger(home)
  const r = installPlugin(home, profile, log, lang)
  log.access('install-plugin result for profile ' + profile + ': ' + r.message, { profile, action: 'install-plugin', ok: r.ok })
  process.stdout.write((r.ok ? '[qaq] ' : '[qaq][error] ') + r.message + '\n')
}

function cmdSetup(_args: CliArgs): void {
  const log = new Logger(resolveDshHome())
  const res = runSetup()
  for (const s of res.steps) process.stdout.write('[qaq][setup] ' + s + '\n')
  if (res.ok) {
    log.access('setup complete', { action: 'setup', ok: true })
    process.stdout.write('[qaq] setup complete. Try: qaq dsh web, or qaq tui.\n')
  } else {
    log.error('setup failed: ' + (res.error ?? 'unknown'))
    process.stderr.write('[qaq][setup] FAILED: ' + (res.error ?? 'unknown') + '\n')
    process.exitCode = 1
  }
}

async function cmdDsh(args: CliArgs): Promise<void> {
  const home = resolveDshHome(); const log = new Logger(home)
  const port = args.port ?? 3080
  const t = makeT(args.lang)

  const report = await preflight({ cwd: args.cwd, port, lang: args.lang })
  const fatal = report.problems.filter(function (x) { return x.sev === 'error' })
  if (fatal.length) {
    log.error(t('cli.fatal.title'))
    for (const f of fatal) log.error('  ' + f.message + ' -> ' + f.hint)
    log.error(t('cli.fatal.hint'))
    return
  }

  let release
  try { release = acquireLock(home) } catch (e) { log.error(String(e instanceof Error ? e.message : e)); return }

  const command = report.command
  const dshEnv: Record<string, string | undefined> = {}

  const guardOpts: GuardOptions = {
    home, profile: args.profile, command, cwd: report.cwd, port,
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

    // Failed: if a rollback was applied, restart and monitor. If the restart
    // STILL fails but the rollback escalated (plan B: walked back to an older
    // snapshot because the restored last-good was itself toxic), keep restarting
    // — each step moves to a strictly older snapshot, bounded by
    // MAX_ESCALATION_STEPS. A failure with rolledBack=false (no older snapshot,
    // fence respected, or env failure) stops the loop to avoid a rollback loop.
    if (verdict.rolledBack) {
      log.warn('rollback applied; restarting dsh web …')
      let steps = 0
      for (;;) {
        const next = await superviseBoot({ ...guardOpts, autoConfirm: true })
        if (next.ok) {
          log.info('post-rollback restart healthy at ' + next.url + '. Guard monitoring.')
          await next.supervisor.exit
          return
        }
        if (!next.rolledBack) {
          log.error('post-rollback restart still failing (kind=' + next.failureKind + '); no further escalation available. Stopping to avoid a rollback loop. Inspect ' + join(qaqDir(home), 'rolled-back') + ' and fix config.')
          return
        }
        steps++
        if (steps >= MAX_ESCALATION_STEPS) {
          log.error('post-rollback escalation stopped after ' + steps + ' failing restarts. Inspect ' + join(qaqDir(home), 'rolled-back') + ' and fix config.')
          return
        }
        log.warn('post-rollback restart still failing (kind=' + next.failureKind + '); escalating to an older snapshot (step ' + steps + ' of ' + MAX_ESCALATION_STEPS + ')…')
      }
    }

    // Failed: the user declined the rollback at the confirmation prompt. Do not
    // restart (an auto-confirmed restart would bypass their explicit refusal).
    if (verdict.rollbackCancelled) {
      log.warn('rollback cancelled by user. Stopping without auto-restart. Inspect ' + join(qaqDir(home), 'rolled-back') + ' and fix config.')
      return
    }

    // Environment/dependency failure: a config rollback cannot fix it, so it
    // was never counted — point the operator at the real cause.
    if (verdict.failureKind === 'env') {
      log.error(t('cli.envFailure', { error: verdict.error ?? '' }))
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

/** qaq watch: attach an external guard to an already-running DSH (any launcher). */
async function cmdWatch(args: CliArgs): Promise<void> {
  const home = resolveDshHome(); const log = new Logger(home)
  const interval = args.intervalMs ?? 0

  // Rollback is CLI-owned here: confirm if interactive and not --yes.
  const useAutoConfirm = args.yes

  if (interval <= 0) {
    const v = await watchOnce({
      home, profile: args.profile, attachPort: args.attach,
      threshold: args.threshold, autoConfirm: useAutoConfirm, uiTimeoutMs: args.uiTimeoutMs,
      webhooks: args.webhooks,
    }, log)
    process.stdout.write(JSON.stringify({ ok: v.ok, kind: v.kind, error: v.error ?? null, rolledBack: v.rolledBack, rollbackCancelled: v.rollbackCancelled ?? false, port: v.port, source: v.source }, null, 2) + '\n')
    return
  }

  // Polling mode.
  log.info('watch: polling every ' + interval + 'ms (Ctrl+C to stop)')
  process.stdout.write('[qaq] watch: polling every ' + interval + 'ms (Ctrl+C to stop)\n')
  const tick = async (): Promise<void> => {
    try {
      const v = await watchOnce({ home, profile: args.profile, attachPort: args.attach, threshold: args.threshold, autoConfirm: useAutoConfirm, uiTimeoutMs: args.uiTimeoutMs, webhooks: args.webhooks }, log)
      const flag = v.ok ? 'OK' : (v.rolledBack ? 'ROLLED-BACK' : v.kind.toUpperCase())
      process.stdout.write('[' + new Date().toISOString() + '] ' + flag + ' url=http://127.0.0.1:' + v.port + (v.error ? ' ' + v.error : '') + '\n')
    } catch (err) {
      log.error('watch tick error: ' + String(err instanceof Error ? err.message : err))
    }
  }
  await tick()
  setInterval(tick, interval)
}

// Auto-run only when this file is the process entry, so the CLI is importable
// for tests (importing it must not spawn a guard / run commands).
import { pathToFileURL } from 'node:url'
const __qaqIsEntry = (() => {
  try {
    const entry = pathToFileURL(process.argv[1] ?? '').href
    return Boolean(entry) && import.meta.url === entry
  } catch { return false }
})()
if (__qaqIsEntry) {
  main().catch((err) => { process.stderr.write('[qaq][fatal] ' + (err instanceof Error ? err.message : String(err)) + '\n'); process.exit(1) })
}
