import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readState, writeState, emptyState, profileState, writeSnapshot, listBackups, readSnapshotKind, AUTO_BACKUP_KEEP,
} from '../src/store.ts'
import { maybeRollback, recordSuccess, manualBackup, DEFAULT_THRESHOLD, isUsable, diffConfig, isInAntiLoop, validateSnapshot } from '../src/rollback.ts'
import { qaqDir, profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'

let home = ''
let log: Logger
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-rollback-'))
  // Create the logger AFTER home is set: a module-level Logger with home=''
  // used to resolve .qaq relative to the cwd and pollute the repo root.
  log = new Logger(home)
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

function setupProfile(name = 'web', pkgJson = '{"name":"p"}', patch = '[]'): void {
  const pr = profileDir(home, name)
  mkdirSync(pr, { recursive: true })
  writeFileSync(join(pr, 'package.json'), pkgJson)
  writeFileSync(join(pr, 'cordis.patch.yml'), patch)
}

describe('rollback', () => {
  it('diffConfig marks changed lines', () => {
    const cur = 'line-a\nkeep\nold-line'
    const tgt = 'line-a\nkeep\nnew-line'
    const d = diffConfig(cur, tgt, 'package.json')
    expect(d).toContain('package.json diff')
    expect(d).toContain('-  old-line')
    expect(d).toContain('+  new-line')
    expect(d).toContain('   keep')
  })

  it('does not roll back below the threshold', async () => {
    setupProfile()
    const s = readState(home); const p = profileState(s, 'web'); p.uiFailures = 2
    writeState(home, s)
    const out = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log })
    expect(out.triggered).toBe(false)
  })

  it('rolls back at threshold if a last-good snapshot exists, backing up the bad config', async () => {
    // Establish last-good snapshot (simulate a healthy config recorded).
    setupProfile('web', '{"name":"good"}')
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'))
    // Now break the live profile.
    setupProfile('web', '{"name":"broken"}', '- bad')
    // Set threshold reached.
    const s = readState(home); const p = profileState(s, 'web'); p.uiFailures = 3
    writeState(home, s)
    const out = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log })
    expect(out.triggered).toBe(true)
    expect(out.rolledBackDir).toBeDefined()
    // Live profile restored to good.
    const livePkg = readFileSync(join(profileDir(home, 'web'), 'package.json'), 'utf8')
    expect(livePkg).toBe('{"name":"good"}')
    // Bad config backed up under rolled-back/.
    const good = existsSync(join(out.rolledBackDir!, 'package.json'))
    expect(good).toBe(true)
    // Anti-loop fence set.
    const after = readState(home)
    expect(after.profiles['web'].rolledBackAt).toBeDefined()
  })

  it('blocks a second rollback while the anti-loop fence is active', async () => {
    const s = readState(home); const p = profileState(s, 'web')
    p.uiFailures = 3
    p.rolledBackAt = new Date(Date.now() - 1000).toISOString() // just rolled back
    writeState(home, s)
    const out = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log })
    expect(out.triggered).toBe(false)
  })

  it('does not roll back when no last-good snapshot exists', async () => {
    // fresh profile, no snapshot
    setupProfile('fresh', '{"name":"broken"}')
    const s = readState(home); const p = profileState(s, 'fresh'); p.uiFailures = 3
    writeState(home, s)
    const out = await maybeRollback({ home, profile: 'fresh', kind: 'ui', autoConfirm: true, log })
    expect(out.triggered).toBe(false)
  })

  it('marks the outcome cancelled when the user declines, without restoring', async () => {
    setupProfile('cancel', '{"name":"good"}')
    recordSuccess(home, 'cancel', log, join(profileDir(home, 'cancel'), 'package.json'), join(profileDir(home, 'cancel'), 'cordis.patch.yml'))
    setupProfile('cancel', '{"name":"broken"}')
    const s = readState(home); const p = profileState(s, 'cancel'); p.uiFailures = 3
    writeState(home, s)
    const out = await maybeRollback({ home, profile: 'cancel', kind: 'ui', autoConfirm: false, confirmYes: async () => false, log })
    expect(out.triggered).toBe(true)
    expect(out.cancelled).toBe(true)
    expect(out.restored).toBe(false)
    // Live config must remain untouched after a decline.
    expect(readFileSync(join(profileDir(home, 'cancel'), 'package.json'), 'utf8')).toBe('{"name":"broken"}')
  })

  it('recordSuccess snapshots latest-good and clears counters/fence', () => {
    setupProfile('web', '{"name":"good"}')
    const s = readState(home); const p = profileState(s, 'web'); p.hostFailures = 7; p.rolledBackAt = new Date().toISOString()
    writeState(home, s)
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'))
    const after = readState(home)
    const ap = after.profiles['web']
    expect(ap.hostFailures).toBe(0)
    expect(ap.lastGoodSnapshot).toBeDefined()
    expect(ap.rolledBackAt).toBeUndefined()
    expect(isUsable(join(qaqDir(home), 'latest-good'))).toBe(true)
  })
})

describe('rollback edge conditions', () => {
  it('isInAntiLoop is false when nothing was rolled back', () => {
    const f = isInAntiLoop(60000)
    expect(f({})).toBe(false)
    expect(f({ rolledBackAt: undefined })).toBe(false)
  })

  it('isInAntiLoop is true inside the window and false after it', () => {
    const f = isInAntiLoop(60000)
    const now = Date.now()
    expect(f({ rolledBackAt: new Date(now - 1000).toISOString() }, now)).toBe(true)
    expect(f({ rolledBackAt: new Date(now - 61000).toISOString() }, now)).toBe(false)
  })

  it('a malformed rolledBackAt does not disable the fence forever (treats it as no-fence)', async () => {
    const s = readState(home)
    const p = profileState(s, 'badts')
    p.uiFailures = 3
    p.rolledBackAt = 'not-a-date'
    writeState(home, s)
    // With no last-good snapshot the outcome is "cannot roll back" (not a crash);
    // the malformed timestamp must not throw and must not silently allow looping.
    const out = await maybeRollback({ home, profile: 'badts', kind: 'ui', autoConfirm: true, log })
    expect(out.triggered).toBe(false)
  })

  it('diffConfig aligns identical lines and marks only genuine changes', () => {
    const cur = 'a\nkeep\nold'
    const tgt = 'a\nkeep\nnew'
    const d = diffConfig(cur, tgt)
    expect(d).toContain('-  old')
    expect(d).toContain('+  new')
    expect(d).toContain('   keep')
    expect(d.match(/\s+keep/g)?.length).toBe(1) // keep appears exactly once
  })

  it('diffConfig detects a truncated version in either direction', () => {
    const d1 = diffConfig('l1\nl2\nl3', 'l1\nl2')
    expect(d1).toContain('-  l3')
    const d2 = diffConfig('l1', 'l1\nl2\nl3')
    expect(d2).toContain('+  l2')
    expect(d2).toContain('+  l3')
  })

  it('manualBackup writes to the MANUAL set only (does not touch counters/latest-good)', () => {
    setupProfile('manual', '{"name":"good"}')
    const s = readState(home); const p = profileState(s, 'manual'); p.hostFailures = 4
    writeState(home, s)
    manualBackup(home, 'manual', log)
    // A manual backup is independent: it does NOT clear counters.
    const after = readState(home)
    expect(after.profiles['manual'].hostFailures).toBe(4)
    // The manual snapshot lives under history/manual and is usable.
    const manual = listBackups(home, 'manual')
    expect(manual.length).toBe(1)
    expect(isUsable(manual[0])).toBe(true)
    const manifest = JSON.parse(readFileSync(join(manual[0], 'manifest.json'), 'utf8'))
    expect(manifest.profile).toBe('manual')
    expect(manifest.kind).toBe('manual')
  })

  it('auto recordSuccess and manualBackup are independent sets with separate quotas', () => {
    // Use an isolated home so exact counts aren't polluted by the shared one.
    const iso = mkdtempSync(join(tmpdir(), 'qaq-rollback-iso-'))
    mkdirSync(join(iso, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(iso, 'profiles', 'web', 'package.json'), '{}')
    writeFileSync(join(iso, 'profiles', 'web', 'cordis.patch.yml'), '[]')
    const ilog = new Logger(iso)
    // Fire several successes -> auto set, pruned to AUTO_BACKUP_KEEP.
    for (let i = 0; i < AUTO_BACKUP_KEEP + 2; i++) {
      recordSuccess(iso, 'web', ilog, join(profileDir(iso, 'web'), 'package.json'), join(profileDir(iso, 'web'), 'cordis.patch.yml'))
    }
    const auto = listBackups(iso, 'auto')
    expect(auto.length).toBe(AUTO_BACKUP_KEEP)
    expect(readSnapshotKind(auto[0])).toBe('auto')
    // A manual backup is separate: adding one here must not disturb the auto set.
    manualBackup(iso, 'web', ilog)
    const manual = listBackups(iso, 'manual')
    expect(manual.length).toBe(1)
    expect(readSnapshotKind(manual[0])).toBe('manual')
    expect(listBackups(iso, 'auto').length).toBe(AUTO_BACKUP_KEEP) // auto untouched
    rmSync(iso, { recursive: true, force: true })
  })
})

describe('snapshot validation (never restore a corrupt snapshot)', () => {
  function snap(name: string, pkgJson: string | null, patch: string | null): string {
    const dir = join(home, 'snaps', name)
    mkdirSync(dir, { recursive: true })
    if (pkgJson !== null) writeFileSync(join(dir, 'package.json'), pkgJson)
    if (patch !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    return dir
  }

  it('accepts a structurally sane snapshot (with or without a patch file)', () => {
    expect(validateSnapshot(snap('ok1', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a'] } } }), '- insert:\n    - id: x\n      name: y\n')).ok).toBe(true)
    // A missing patch layer is valid (optional).
    expect(validateSnapshot(snap('ok2', JSON.stringify({ name: 'p' }), null)).ok).toBe(true)
  })

  it('rejects corrupt package.json / broken bundles / empty or non-array patches', () => {
    expect(validateSnapshot(snap('bad-json', '{oops', null)).ok).toBe(false)
    expect(validateSnapshot(snap('no-pkg', null, '[]')).ok).toBe(false)
    expect(validateSnapshot(snap('bad-bundles', JSON.stringify({ name: 'p', dsh: { profile: { bundles: 'nope' } } }), '[]')).ok).toBe(false)
    expect(validateSnapshot(snap('empty-patch', JSON.stringify({ name: 'p' }), '')).ok).toBe(false)
    expect(validateSnapshot(snap('comment-patch', JSON.stringify({ name: 'p' }), '# only comments')).ok).toBe(false)
    expect(validateSnapshot(snap('scalar-patch', JSON.stringify({ name: 'p' }), 'just a string')).ok).toBe(false)
  })

  it('rolls back to the newest VALID auto snapshot when the state pointer targets a corrupt one', async () => {
    const iso = mkdtempSync(join(tmpdir(), 'qaq-rollback-fallback-'))
    mkdirSync(join(iso, 'profiles', 'web'), { recursive: true })
    const ilog = new Logger(iso)
    // 1. Seed a healthy profile + record success (writes latest-good + auto #1).
    const pr = profileDir(iso, 'web')
    writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    writeFileSync(join(pr, 'cordis.patch.yml'), '[]')
    recordSuccess(iso, 'web', ilog, join(pr, 'package.json'), join(pr, 'cordis.patch.yml'))
    const state0 = readState(iso)
    const goodTs = state0.profiles['web'].lastGoodSnapshot! // 'history/auto/<ts>'
    // 2. Corrupt BOTH the pointer target and latest-good (simulating disk damage).
    writeFileSync(join(qaqDir(iso), goodTs, 'package.json'), '{corrupted')
    writeFileSync(join(qaqDir(iso), 'latest-good', 'package.json'), '{corrupted')
    // 3. A NEWER valid auto snapshot exists (a later healthy boot).
    const pr2 = profileDir(iso, 'web')
    writeFileSync(join(pr2, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-extra'] } } }))
    recordSuccess(iso, 'web', ilog, join(pr2, 'package.json'), join(pr2, 'cordis.patch.yml'))
    // 4. Break the live profile and reach the threshold.
    writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'web', dependencies: { 'dsh-broken-theme': 'link:D:/x' } }))
    const s = readState(iso); const p = profileState(s, 'web'); p.uiFailures = 3
    writeState(iso, s)

    const out = await maybeRollback({ home: iso, profile: 'web', kind: 'ui', autoConfirm: true, log: ilog })
    expect(out.triggered).toBe(true)
    expect(out.restored).toBe(true)
    // The live config was restored from the newest VALID auto snapshot (has dsh-extra).
    const restored = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(restored.dsh?.profile?.bundles).toContain('dsh-extra')
    rmSync(iso, { recursive: true, force: true })
  })
})
