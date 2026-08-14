/**
 * Rollback engine: on a threshold of like-kind consecutive failures, restore the
 * last-good snapshot into the profile dir, first preserving the坏 config in
 * rolled-back/, and enforce the anti-loop fence (one rollback per time window).
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readState, writeState, profileState, restoreSnapshot, pruneSnapshots, writeSnapshot } from './store.ts'
import { qaqDir, profileDir } from './paths.ts'
import { Logger } from './log.ts'

export interface RollbackContext {
  home: string
  profile: string
  /** Which failure kind reached the threshold. */
  kind: 'host' | 'ui'
  /** Whether to auto-confirm rollback (--yes) or prompt in the console. */
  autoConfirm: boolean
  log: Logger
  /** Console input for confirmation (injectable for tests). */
  confirmYes?: () => Promise<boolean>
  /** Number of consecutive like-kind failures that triggers rollback. */
  threshold?: number
}

export interface RollbackOutcome {
  triggered: boolean
  snappedGood: boolean
  restored: boolean
  badBackedUp: boolean
  /** Directory of the bad snapshot saved to rolled-back/. */
  rolledBackDir?: string
}

/** Default threshold: 3 consecutive like-kind failures. */
export const DEFAULT_THRESHOLD = 3
/** Anti-loop window: a rollback is only allowed once per this window. */
export const ANTI_LOOP_MS = 5 * 60 * 1000

/** True if a rollback is currently "in effect" for the profile (anti-loop). */
export function isInAntiLoop(windowMs = ANTI_LOOP_MS): (profile: { rolledBackAt?: string }, now?: number) => boolean {
  return (profile, now = Date.now()) => {
    if (!profile.rolledBackAt) return false
    return now - Date.parse(profile.rolledBackAt) < windowMs
  }
}

/** The user-console confirmation prompt (Y/N). */
async function defaultConfirm(): Promise<boolean> {
  process.stdout.write('[qaq] Roll back profile to last-good config? (y/N) ')
  return new Promise((resolvePrompt) => {
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += String(d)
      if (buf.includes('\n') || buf.includes('\r')) {
        process.stdin.off('data', onData)
        process.stdin.pause()
        resolvePrompt(/^\s*y(?:es)?\s*$/i.test(buf.trim()))
      }
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

/**
 * Decide and perform a rollback. Returns the outcome; triggered==false means no
 * rollback was warranted or the fence/confirmation blocked it.
 */
export async function maybeRollback(ctx: RollbackContext): Promise<RollbackOutcome> {
  const threshold = ctx.threshold ?? DEFAULT_THRESHOLD
  const state = readState(ctx.home)
  const prof = profileState(state, ctx.profile)

  // Determine consecutive count for this kind.
  const n = ctx.kind === 'host' ? prof.hostFailures : prof.uiFailures
  if (n < threshold) return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }

  // Anti-loop fence.
  const now = Date.now()
  if (prof.rolledBackAt && now - Date.parse(prof.rolledBackAt) < ANTI_LOOP_MS) {
    ctx.log.warn(ctx.profile + ': rollback threshold reached but anti-loop fence is active (last rollback ' + prof.rolledBackAt + '). Stopping; start clean after fixing config manually.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }

  // Resolve THIS profile's last-good snapshot. Prefer the per-profile
  // state.lastGoodSnapshot ("history/<ts>"); otherwise accept latest-good only
  // when its manifest declares the same profile (so a foreign profile's data
  // is never used for another).
  const q = qaqDir(ctx.home)
  let good: string | null = null
  if (prof.lastGoodSnapshot) {
    const ref = prof.lastGoodSnapshot.startsWith('history/') ? prof.lastGoodSnapshot : 'history/' + prof.lastGoodSnapshot
    good = join(q, ref)
    if (!isUsable(good)) good = null
  }
  if (!good) {
    const latest = join(q, 'latest-good')
    if (isUsable(latest) && snapshotProfile(latest) === ctx.profile) good = latest
  }
  if (!good) {
    ctx.log.warn('no last-good snapshot yet for profile ' + ctx.profile + '; cannot roll back. Start a known-good boot first.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }

  // Backup the坏 (current live) config before overwriting.
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rolledBackDir = join(q, 'rolled-back', ts)
  mkdirSync(rolledBackDir, { recursive: true })
  const profileDirPath = profileDir(ctx.home, ctx.profile)
  const pj = join(profileDirPath, 'package.json')
  const cp = join(profileDirPath, 'cordis.patch.yml')
  if (existsSync(pj)) copyFileSync(pj, join(rolledBackDir, 'package.json'))
  if (existsSync(cp)) copyFileSync(cp, join(rolledBackDir, 'cordis.patch.yml'))
  writeFileQuiet(join(rolledBackDir, 'manifest.json'), JSON.stringify({ profile: ctx.profile, ts: new Date().toISOString(), note: 'bad config preserved before rollback' }, null, 2))

  // Confirmation.
  let proceed = true
  if (!ctx.autoConfirm) {
    const confirm = ctx.confirmYes ?? defaultConfirm
    proceed = await confirm()
  }
  if (!proceed) {
    ctx.log.info('rollback cancelled by user.')
    return { triggered: true, snappedGood: false, restored: false, badBackedUp: true, rolledBackDir }
  }

  // Restore.
  await restoreSnapshot(ctx.home, ctx.profile, good)
  prof.rolledBackAt = new Date(now).toISOString()
  writeState(ctx.home, state)
  ctx.log.warn('rolled back ' + ctx.profile + ' to last-good; bad config saved to ' + rolledBackDir)
  return { triggered: true, snappedGood: true, restored: true, badBackedUp: true, rolledBackDir }
}

function snapshotProfile(dir: string): string {
  try { return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).profile ?? '' } catch { return '' }
}

export function isUsable(goodDir: string): boolean {
  return existsSync(join(goodDir, 'package.json'))
}
function writeFileQuiet(path: string, data: string): void {
  try { writeFileSync(path, data) } catch { /* ignore */ }
}

/**
 * Record a success: zero both counters, set lastSuccess, and snapshot the
 * current profile as latest-good + history.
 */
export function recordSuccess(home: string, profile: string, log: Logger, packageJsonPath: string, patchYmlPath: string | null): void {
  const state = readState(home)
  const prof = profileState(state, profile)
  prof.hostFailures = 0
  prof.uiFailures = 0
  prof.lastSuccess = new Date().toISOString()
  // Clear the anti-loop fence on a genuine success.
  delete prof.rolledBackAt
  writeState(home, state)

  const q = qaqDir(home)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  // latest-good: write fresh, keep as the canonical copy.
  writeSnapshot(home, join(q, 'latest-good'), { packageJson: packageJsonPath, patchYml: patchYmlPath })
  // history: time-stamped copy, prune to 5.
  writeSnapshot(home, join(q, 'history', ts), { packageJson: packageJsonPath, patchYml: patchYmlPath })
  pruneSnapshots(home, 'history', 5)
  const good = join(q, 'latest-good', 'manifest.json')
  // record lastGoodSnapshot path in state
  state.profiles[profile].lastGoodSnapshot = 'history/' + ts
  writeState(home, state)
  log.info('recorded success and snapshot for profile ' + profile)
}

/** Manual backup: snapshot current profile into latest-good. */
export function manualBackup(home: string, profile: string, log: Logger): void {
  const pr = profileDir(home, profile)
  recordSuccess(home, profile, log, join(pr, 'package.json'), join(pr, 'cordis.patch.yml'))
}

/** Manual restore from a snapshot dir. */
export function manualRestore(home: string, profile: string, snapDir: string, log: Logger): void {
  restoreSnapshot(home, profile, snapDir)
  log.warn('restored profile ' + profile + ' from ' + snapDir)
}