import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readState, writeState, emptyState, profileState, ensureQaqDir,
  writeSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, acquireLock,
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
})