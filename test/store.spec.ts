import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readState, writeState, emptyState, profileState, ensureQaqDir,
  writeSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, acquireLock,
  listBackups, readSnapshotKind,
  AUTO_BACKUP_DIR, MANUAL_BACKUP_DIR, AUTO_BACKUP_KEEP, MANUAL_BACKUP_KEEP,
} from '../src/store.ts'
import { qaqDir, profileDir } from '../src/paths.ts'

let home = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-store-')) })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('store', () => {
  it('reads default state when absent', () => {
    const s = readState(home)
    expect(s.version).toBe(1)
    expect(s.profiles).toEqual({})
    expect(s.config.autoConfirm).toBe(false)
  })

  it('atomically writes and reads state', () => {
    const s = emptyState(true)
    const p = profileState(s, 'web')
    p.hostFailures = 2
    p.lastFailure = { kind: 'host', ts: new Date().toISOString(), error: 'boom' }
    writeState(home, s)
    const back = readState(home)
    expect(back.profiles['web'].hostFailures).toBe(2)
    expect(back.profiles['web'].lastFailure?.kind).toBe('host')
    expect(back.config.autoConfirm).toBe(true)
  })

  it('treats corrupt state as empty', () => {
    writeState(home, { version: 1, profiles: 'nope', config: { autoConfirm: false } } as any)
    const s = readState(home)
    expect(s.profiles).toEqual({})
  })

  it('writes lists and prunes snapshots', () => {
    const pr = profileDir(home, 'web')
    mkdirSync(pr, { recursive: true })
    writeFileSync(join(pr, 'package.json'), '{}')
    writeFileSync(join(pr, 'cordis.patch.yml'), '[]')
    // write 6 snapshots
    for (let i = 0; i < 6; i++) {
      const ts = '2026-08-15T00-00-' + String(i).padStart(2, '0') + '-000Z'
      writeSnapshot(home, join(qaqDir(home), 'history', ts), { packageJson: join(pr, 'package.json'), patchYml: join(pr, 'cordis.patch.yml') }, 'web')
    }
    pruneSnapshots(home, 'history', 5)
    const snaps = listSnapshots(home, 'history')
    expect(snaps.length).toBe(5)
    // The manifest must record the actual profile name (regression: it used to
    // derive a bogus name from the snapshot path).
    const manifest = JSON.parse(readFileSync(join(snaps[0], 'manifest.json'), 'utf8'))
    expect(manifest.profile).toBe('web')
  })

  it('restores snapshot files into a profile dir', () => {
    const pr = profileDir(home, 'web')
    // first snapshot (after prune the oldest was removed; use any snapshot)
    const snaps = listSnapshots(home, 'history')
    expect(snaps.length).toBeGreaterThan(0)
    // Corrupt the profile, then restore from a snapshot.
    writeFileSync(join(pr, 'package.json'), '{broken}')
    restoreSnapshot(home, 'web', snaps[snaps.length - 1])
    const restored = readFileSync(join(pr, 'package.json'), 'utf8')
    expect(restored).toBe('{}')
  })

  it('acquires and releases the guard lock', () => {
    const release = acquireLock(home)
    expect(() => acquireLock(home)).toThrow()
    release()
    // After release it can be acquired again.
    const r2 = acquireLock(home)
    r2()
  })

  it('reclaims a stale lock whose owner PID is not alive (crashed guard)', () => {
    const lp = join(qaqDir(home), '.guard.lock')
    // A PID that is very unlikely to exist (far beyond typical pid_max).
    writeFileSync(lp, '99999999', 'utf8')
    // Must succeed: the stale lock is reclaimed, not a fatal "another instance".
    expect(() => acquireLock(home)).not.toThrow()
    expect(existsSync(lp)).toBe(true) // rewritten with the current pid
    // Cleanup so later tests (temp dir re-use) are unaffected.
    rmSync(lp, { force: true })
  })

  it('reclaims a lock file whose contents are not a number (corrupt/garbage)', () => {
    const lp = join(qaqDir(home), '.guard.lock')
    writeFileSync(lp, 'not-a-pid', 'utf8')
    expect(() => acquireLock(home)).not.toThrow()
    rmSync(lp, { force: true })
  })
})

describe('backup sets (auto vs manual)', () => {
  beforeAll(() => {
    mkdirSync(join(profileDir(home, 'web')), { recursive: true })
    writeFileSync(join(profileDir(home, 'web'), 'package.json'), '{"name":"web"}')
    writeFileSync(join(profileDir(home, 'web'), 'cordis.patch.yml'), '[]')
  })

  it('exposes the intended independent quotas', () => {
    expect(AUTO_BACKUP_KEEP).toBe(10)
    expect(MANUAL_BACKUP_KEEP).toBe(3)
    expect(AUTO_BACKUP_DIR).toBe('history/auto')
    expect(MANUAL_BACKUP_DIR).toBe('history/manual')
  })

  it('listBackups returns [] for a kind with nothing written yet', () => {
    expect(listBackups(home, 'auto')).toEqual([])
    expect(listBackups(home, 'manual')).toEqual([])
  })

  it('writeSnapshot stamps the kind and readSnapshotKind defaults to auto on corrupt/a missing manifest', () => {
    const autoDir = join(qaqDir(home), AUTO_BACKUP_DIR, 'auto-1')
    writeSnapshot(home, autoDir, { packageJson: join(profileDir(home, 'web'), 'package.json'), patchYml: join(profileDir(home, 'web'), 'cordis.patch.yml') }, 'web', 'auto')
    const m = JSON.parse(readFileSync(join(autoDir, 'manifest.json'), 'utf8'))
    expect(m.kind).toBe('auto')
    expect(readSnapshotKind(autoDir)).toBe('auto')
    // Manual stamped.
    const manualDir = join(qaqDir(home), MANUAL_BACKUP_DIR, 'manual-1')
    writeSnapshot(home, manualDir, { packageJson: join(profileDir(home, 'web'), 'package.json'), patchYml: join(profileDir(home, 'web'), 'cordis.patch.yml') }, 'web', 'manual')
    expect(readSnapshotKind(manualDir)).toBe('manual')
    // A non-snapshot dir with no manifest -> auto default.
    mkdirSync(join(qaqDir(home), 'random'), { recursive: true })
    expect(readSnapshotKind(join(qaqDir(home), 'random'))).toBe('auto')
  })

  it('listBackups separates auto from manual by directory', () => {
    expect(listBackups(home, 'auto')).toHaveLength(1)
    expect(listBackups(home, 'manual')).toHaveLength(1)
  })
})
