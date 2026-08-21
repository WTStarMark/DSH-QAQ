/**
 * Rollback engine: on a threshold of like-kind consecutive failures, restore the
 * last-good snapshot into the profile dir, first preserving the bad config in
 * rolled-back/, and enforce the anti-loop fence (one rollback per time window).
 *
 * Guard plan B (anti-loop escalation): the fence exists to stop REPEATED
 * rollback of the SAME bad config. When the restored last-good is itself the
 * failure source (it was recorded while the running DSH was still on an OLDER,
 * healthy config - the plan-A pollution scenario), a repeat failure inside the
 * fence window means the restore did not help. Escalation walks back to a
 * strictly OLDER valid snapshot (rollbackEscalation.offset grows), which is a
 * NEW decision about a DIFFERENT config, so the fence is bypassed for that step
 * only. Each successful restore seeds the walk-back state; a genuine success
 * (recordSuccess) clears it.
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readState, writeState, profileState, restoreSnapshot, pruneSnapshots, writeSnapshot, listBackups, AUTO_BACKUP_DIR, MANUAL_BACKUP_DIR, AUTO_BACKUP_KEEP, MANUAL_BACKUP_KEEP } from './store.ts'
import { qaqDir, profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { pushEvent } from './shared-io.ts'

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
  /** Guard plan B: allow walking back to an OLDER valid snapshot when the
   *  restored last-good is itself still failing and the anti-loop fence is
   *  active. Applies to that escalation step only; the fence still blocks a
   *  repeat of the identical rollback. */
  allowEscalation?: boolean
}

export interface RollbackOutcome {
  triggered: boolean
  snappedGood: boolean
  restored: boolean
  badBackedUp: boolean
  /** True when the threshold was reached but the user declined the rollback at the prompt. */
  cancelled?: boolean
  /** Directory of the bad snapshot saved to rolled-back/. */
  rolledBackDir?: string
  /** Guard plan B: true when this rollback walked back to an OLDER snapshot
   *  (the newly-restored last-good was itself failing inside the fence window). */
  escalated?: boolean
  /** The ordered index of the snapshot restored (0 = newest valid). */
  offset?: number
}

/** Default threshold: 3 consecutive like-kind failures. */
export const DEFAULT_THRESHOLD = 3
/** Anti-loop window: a rollback is only allowed once per this window. */
export const ANTI_LOOP_MS = 5 * 60 * 1000
/** Plan B: maximum walk-back escalation steps per fence window (safety cap). */
export const MAX_ESCALATION_STEPS = 4

/** True if a rollback is currently "in effect" for the profile (anti-loop). */
export function isInAntiLoop(windowMs = ANTI_LOOP_MS): (profile: { rolledBackAt?: string }, now?: number) => boolean {
  return (profile, now = Date.now()) => {
    if (!profile.rolledBackAt) return false
    return now - Date.parse(profile.rolledBackAt) < windowMs
  }
}

/** A minimal line-based diff: mark lines that differ between current and target (simple LCS). */
export function diffConfig(currentText: string, targetText: string, label = 'config'): string {
  const a = currentText.split('\n')
  const b = targetText.split('\n')
  // LCS to align lines.
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push('   ' + a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-  ' + a[i]); i++ }
    else { out.push('+  ' + b[j]); j++ }
  }
  while (i < n) { out.push('-  ' + a[i]); i++ }
  while (j < m) { out.push('+  ' + b[j]); j++ }
  return (label + ' diff (current -> last-good):\n' + out.join('\n')).slice(0, 4000)
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
 *
 * Plan B: when ctx.allowEscalation is set and the fence is active but a prior
 * rollback seeded rollbackEscalation, the next failure walks back to the NEXT
 * OLDER valid snapshot (offset+1) instead of being hard-blocked. The fence still
 * applies whenever there is no older snapshot to walk to (progress is
 * impossible), so the operator is never left to an infinite rollback loop.
 */
export async function maybeRollback(ctx: RollbackContext): Promise<RollbackOutcome> {
  const threshold = ctx.threshold ?? DEFAULT_THRESHOLD
  const state = readState(ctx.home)
  const prof = profileState(state, ctx.profile)

  // Determine consecutive count for this kind.
  const n = ctx.kind === 'host' ? prof.hostFailures : prof.uiFailures
  if (n < threshold) return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }

  // Anti-loop fence + plan B escalation offset.
  const now = Date.now()
  const rbTs = prof.rolledBackAt ? Date.parse(prof.rolledBackAt) : NaN
  // A malformed rolledBackAt (Date.parse -> NaN) must not silently disable the
  // fence: treat it as no-fence and let the operator repair state.json.
  const fenceActive = Boolean(prof.rolledBackAt && !Number.isNaN(rbTs) && now - rbTs < ANTI_LOOP_MS)
  const esc = prof.rollbackEscalation
  const escActive = Boolean(esc && !Number.isNaN(Date.parse(esc.ts)) && now - Date.parse(esc.ts) < ANTI_LOOP_MS)
  // Walk-back offset: only inside the fence window, when a previous rollback
  // seeded the escalation state and the caller opted in. offset>0 = escalation.
  const offset = fenceActive && escActive && ctx.allowEscalation ? esc!.offset + 1 : 0
  const escalating = offset > 0
  if (fenceActive && !escalating) {
    ctx.log.warn(ctx.profile + ': rollback threshold reached but anti-loop fence is active (last rollback ' + prof.rolledBackAt + '). Stopping; start clean after fixing config manually.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }
  if (escalating && offset > MAX_ESCALATION_STEPS) {
    ctx.log.warn(ctx.profile + ': escalation walk-back capped at ' + MAX_ESCALATION_STEPS + ' steps; stopping to avoid a rollback loop.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }

  // Resolve THIS profile's ordered VALID snapshot list (newest-first). Prefer
  // the per-profile state.lastGoodSnapshot; accept latest-good only when its
  // manifest declares the same profile. Every candidate is VALIDATED before
  // use: a corrupt snapshot (bad JSON / broken bundles / empty patch) must
  // never be restored - it would reproduce the very failure the guard exists
  // to repair.
  const q = qaqDir(ctx.home)
  const candidates: string[] = []
  const seen = new Set<string>()
  const consider = (dir: string): void => {
    if (!seen.has(dir)) { seen.add(dir); candidates.push(dir) }
  }
  if (prof.lastGoodSnapshot) {
    const ref = prof.lastGoodSnapshot.startsWith('history/') ? prof.lastGoodSnapshot : 'history/' + prof.lastGoodSnapshot
    consider(join(q, ref))
  }
  consider(join(q, 'latest-good'))
  // Fallback: the newest VALID auto snapshot for this profile (self-heals a
  // corrupt state pointer or a clobbered latest-good).
  for (const dir of listBackups(ctx.home, 'auto')) {
    if (snapshotProfile(dir) !== ctx.profile) continue
    consider(dir)
  }
  const valid: string[] = []
  for (const dir of candidates) {
    if (!isUsable(dir) || !validateSnapshot(dir).ok) continue
    // latest-good only counts when its manifest declares the same profile.
    if (dir === join(q, 'latest-good') && snapshotProfile(dir) !== ctx.profile) continue
    valid.push(dir)
  }
  if (valid.length === 0) {
    ctx.log.warn('no valid last-good snapshot for profile ' + ctx.profile + '; cannot roll back. Start a known-good boot first.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }
  const good = valid[offset] ?? null
  if (escalating && good === null) {
    // No older valid snapshot to walk to: progress is impossible this window.
    ctx.log.warn(ctx.profile + ': restored last-good is still failing but no older valid snapshot exists to escalate to. Stopping; start clean after fixing config manually.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }
  if (good === null) {
    ctx.log.warn('no valid last-good snapshot for profile ' + ctx.profile + '; cannot roll back. Start a known-good boot first.')
    return { triggered: false, snappedGood: false, restored: false, badBackedUp: false }
  }

  // Backup the bad (current live) config before overwriting.
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rolledBackDir = join(q, 'rolled-back', ts)
  mkdirSync(rolledBackDir, { recursive: true })
  const profileDirPath = profileDir(ctx.home, ctx.profile)
  const pj = join(profileDirPath, 'package.json')
  const cp = join(profileDirPath, 'cordis.patch.yml')
  if (existsSync(pj)) copyFileSync(pj, join(rolledBackDir, 'package.json'))
  if (existsSync(cp)) copyFileSync(cp, join(rolledBackDir, 'cordis.patch.yml'))
  writeFileQuiet(join(rolledBackDir, 'manifest.json'), JSON.stringify({ profile: ctx.profile, ts: new Date().toISOString(), note: 'bad config preserved before rollback' + (escalating ? ' (escalation offset ' + offset + ')' : '') }, null, 2))

  // Confirmation (with a diff preview of what the rollback will change).
  let proceed = true
  if (!ctx.autoConfirm) {
    // Show what would change before asking.
    try {
      const pr = profileDir(ctx.home, ctx.profile)
      for (const f of ['package.json', 'cordis.patch.yml'] as const) {
        const cur = existsSync(join(pr, f)) ? readFileSync(join(pr, f), 'utf8') : ''
        const tgt = existsSync(join(good, f)) ? readFileSync(join(good, f), 'utf8') : ''
        if (cur !== tgt) process.stdout.write(diffConfig(cur, tgt, f))
      }
    } catch { /* diff is best-effort; still prompt */ }
    const confirm = ctx.confirmYes ?? defaultConfirm
    proceed = await confirm()
  }
  if (!proceed) {
    ctx.log.info('rollback cancelled by user.')
    return { triggered: true, snappedGood: false, restored: false, badBackedUp: true, cancelled: true, rolledBackDir }
  }

  // Restore.
  await restoreSnapshot(ctx.home, ctx.profile, good)
  prof.rolledBackAt = new Date(now).toISOString()
  // Plan B: seed the walk-back state so a subsequent same-window failure can
  // escalate to the NEXT older snapshot instead of being hard-blocked.
  prof.rollbackEscalation = { offset, ts: new Date(now).toISOString() }
  writeState(ctx.home, state)
  ctx.log.access('rolled back ' + ctx.profile + ' to last-good' + (escalating ? ' (escalation offset ' + offset + ')' : '') + '; bad config saved to ' + rolledBackDir, { kind: ctx.kind, action: 'rollback', rolledBackDir, escalated: escalating, offset })
  ctx.log.warn('rolled back ' + ctx.profile + ' to last-good' + (escalating ? ' (escalation offset ' + offset + ')' : '') + '; bad config saved to ' + rolledBackDir)
  return { triggered: true, snappedGood: true, restored: true, badBackedUp: true, rolledBackDir, escalated: escalating, offset }
}

function snapshotProfile(dir: string): string {
  try { return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).profile ?? '' } catch { return '' }
}

export function isUsable(goodDir: string): boolean {
  return existsSync(join(goodDir, 'package.json'))
}

/** Result of validating a snapshot's restore-able content. */
export interface SnapshotValidity { ok: boolean; reason?: string }

/**
 * Validate a snapshot BEFORE it is ever restored: the package.json must parse
 * and keep a structurally sane dsh.profile.bundles, and a present
 * cordis.patch.yml must not be empty / comment-only (DSH rejects those - it
 * parses to nothing, not to a list). Restoring a corrupt snapshot would just
 * reproduce the very boot failure the guard exists to repair, so a failed
 * validation forces the rollback to fall back to an older valid snapshot.
 */
export function validateSnapshot(dir: string): SnapshotValidity {
  const pjPath = join(dir, 'package.json')
  if (!existsSync(pjPath)) return { ok: false, reason: 'missing package.json' }
  let pkg: unknown
  try { pkg = JSON.parse(readFileSync(pjPath, 'utf8')) } catch { return { ok: false, reason: 'package.json is not valid JSON' } }
  if (!pkg || typeof pkg !== 'object') return { ok: false, reason: 'package.json is not an object' }
  const bundles = (pkg as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) return { ok: false, reason: 'dsh.profile.bundles is not an array' }
  const patchPath = join(dir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    let text: string
    try { text = readFileSync(patchPath, 'utf8') } catch { return { ok: false, reason: 'cordis.patch.yml is unreadable' } }
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
    const body = lines.filter((l) => !l.startsWith('#'))
    // A patch with no content at all is a boot failure on DSH (parses to nothing).
    if (body.length === 0) return { ok: false, reason: 'cordis.patch.yml is empty/comment-only (DSH rejects it)' }
    // The first real line must look like a YAML array ([) or a list item (-).
    if (!/^\[/.test(body[0]) && !/^-/.test(body[0])) return { ok: false, reason: 'cordis.patch.yml is not an array/insert list' }
  }
  return { ok: true }
}
function writeFileQuiet(path: string, data: string): void {
  try { writeFileSync(path, data) } catch { /* ignore */ }
}

/** Optional verifier passed to recordSuccess (guard plan A). Return
 *  { match: true } to bless, { match: false } to REFUSE blessing, or
 *  { match: null } when the loaded config cannot be compared (fall back to bless). */
export type SuccessVerifier = () => { match: boolean | null; reason?: string }

/**
 * Record a success - an AUTOMATIC backup (the guard confirmed a healthy boot, or
 * the sideload watched a healthy foreign boot): zero both counters, set
 * lastSuccess, snapshot the current profile into the auto backup set, and clear
 * the anti-loop fence.
 *
 * Guard plan A: when a `verifier` is supplied and reports { match: false }, the
 * on-disk config being blessed is NOT what the running DSH booted with (a bundle
 * edit pending a restart - the running process was healthy on an OLDER config).
 * Blessing it would poison last-good with a config that red-screens on the next
 * boot, so the success is NOT recorded: counters and last-good stay put, and an
 * event is pushed so the operator sees why.
 */
export function recordSuccess(home: string, profile: string, log: Logger, packageJsonPath: string, patchYmlPath: string | null, verifier?: SuccessVerifier): void {
  if (verifier) {
    let v: { match: boolean | null; reason?: string }
    try { v = verifier() } catch { v = { match: null, reason: 'verifier threw' } }
    if (v.match === false) {
      pushEvent(home, 'config-not-verified', profile, { reason: v.reason ?? 'loaded config differs from on-disk config' })
      log.warn(profile + ': healthy UI but on-disk config differs from what the running DSH loaded; NOT recording as last-good (' + (v.reason ?? '') + ')')
      return
    }
  }
  const state = readState(home)
  const prof = profileState(state, profile)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  // Set every state field together (counters, lastSuccess, anti-loop fence, and
  // the lastGoodSnapshot pointer) and persist ONCE, so the recorded snapshot
  // reference and the counters never drift apart across two separate writes.
  prof.hostFailures = 0
  prof.uiFailures = 0
  prof.lastSuccess = new Date().toISOString()
  // Clear the anti-loop fence on a genuine success (and any plan-B walk-back
  // state - a real success means the current config is good again).
  delete prof.rolledBackAt
  delete prof.rollbackEscalation
  prof.lastGoodSnapshot = AUTO_BACKUP_DIR + '/' + ts
  writeState(home, state)

  const q = qaqDir(home)
  // Auto backup set: latest-good (canonical) + timestamped history/auto copy.
  writeSnapshot(home, join(q, 'latest-good'), { packageJson: packageJsonPath, patchYml: patchYmlPath }, profile, 'auto')
  writeSnapshot(home, join(q, AUTO_BACKUP_DIR, ts), { packageJson: packageJsonPath, patchYml: patchYmlPath }, profile, 'auto')
  pruneSnapshots(home, AUTO_BACKUP_DIR, AUTO_BACKUP_KEEP)
  log.access('recorded auto success snapshot for profile ' + profile, { profile, ts, snapshots: 'latest-good + ' + AUTO_BACKUP_DIR + '/' + ts })
  log.info('recorded auto success snapshot for profile ' + profile)
}

/**
 * Manual backup: snapshot the current profile into the MANUAL set only
 * (history/manual/, keep 3), independent of the auto set. Unlike a success
 * record, a manual backup does NOT touch counters, lastSuccess, lastGoodSnapshot,
 * or the anti-loop fence.
 */
export function manualBackup(home: string, profile: string, log: Logger): void {
  const pr = profileDir(home, profile)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const q = qaqDir(home)
  const snapDir = join(q, MANUAL_BACKUP_DIR, ts)
  writeSnapshot(home, snapDir, { packageJson: join(pr, 'package.json'), patchYml: join(pr, 'cordis.patch.yml') }, profile, 'manual')
  pruneSnapshots(home, MANUAL_BACKUP_DIR, MANUAL_BACKUP_KEEP)
  log.access('manual backup for profile ' + profile + ' -> ' + snapDir, { profile, action: 'manual-backup', snapDir })
  log.info('manual backup for profile ' + profile)
}

/** Manual restore from a snapshot dir. */
export function manualRestore(home: string, profile: string, snapDir: string, log: Logger): void {
  restoreSnapshot(home, profile, snapDir)
  log.access('manually restored profile ' + profile + ' from ' + snapDir, { profile, action: 'restore', snapDir })
  log.warn('restored profile ' + profile + ' from ' + snapDir)
}
