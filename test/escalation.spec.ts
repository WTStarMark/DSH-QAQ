import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maybeRollback, recordSuccess } from '../src/rollback.ts'
import { readState, writeState, profileState } from '../src/store.ts'
import { qaqDir, profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'

/**
 * Guard plan B - anti-loop escalation: when the restored last-good is itself
 * the failure source (it was recorded while the running DSH was on an OLDER,
 * healthy config), a repeat failure inside the fence window must walk back to
 * the NEXT OLDER valid snapshot instead of being hard-blocked by the fence.
 *
 * Each test gets a FRESH temp home so snapshot/state accumulation across tests
 * cannot skew the ordered valid-snapshot walk-back.
 */
let home = ''
let log: Logger
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-escalation-'))
  log = new Logger(home)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function writeSnapshotWith(ts: string, bundleJson: string, patch = '[]'): void {
  const snapDir = join(qaqDir(home), 'history', 'auto', ts)
  mkdirSync(snapDir, { recursive: true })
  writeFileSync(join(snapDir, 'package.json'), bundleJson)
  writeFileSync(join(snapDir, 'cordis.patch.yml'), patch)
  writeFileSync(join(snapDir, 'manifest.json'), JSON.stringify({ profile: 'web', kind: 'auto', ts }, null, 2))
}
function liveConfig(): string {
  return readFileSync(join(profileDir(home, 'web'), 'package.json'), 'utf8')
}
function setLive(bundleJson: string, patch = '[]'): void {
  const pr = profileDir(home, 'web')
  mkdirSync(pr, { recursive: true })
  writeFileSync(join(pr, 'package.json'), bundleJson)
  writeFileSync(join(pr, 'cordis.patch.yml'), patch)
}
function setFailures(n: number): void {
  const s = readState(home); const p = profileState(s, 'web'); p.uiFailures = n
  writeState(home, s)
}
function setLastGood(ts: string): void {
  const s = readState(home); const p = profileState(s, 'web'); p.lastGoodSnapshot = 'history/auto/' + ts
  writeState(home, s)
}

describe('plan B: anti-loop escalation walk-back', () => {
  it('walks back to the NEXT older snapshot when the restored last-good is itself still failing', async () => {
    // Snapshots newest->oldest: ts3 (poisoned, 'broken'), ts2 ('a+b'), ts1 ('a').
    writeSnapshotWith('2026-08-21T03-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a', 'b', 'broken'] } } }))
    writeSnapshotWith('2026-08-21T02-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a', 'b'] } } }))
    writeSnapshotWith('2026-08-21T01-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a'] } } }))
    setLastGood('2026-08-21T03-00-00-000Z')
    setLive(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a', 'b', 'broken'] } } }))
    setFailures(1)

    const out1 = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(out1.triggered).toBe(true)
    expect(out1.offset).toBe(0)
    expect(out1.escalated).toBeFalsy()
    expect(readState(home).profiles['web'].rollbackEscalation?.offset).toBe(0)

    setFailures(1)
    const out2 = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(out2.triggered).toBe(true)
    expect(out2.escalated).toBe(true)
    expect(out2.offset).toBe(1)
    expect(JSON.parse(liveConfig()).dsh.profile.bundles).toEqual(['a', 'b'])
    expect(readState(home).profiles['web'].rollbackEscalation?.offset).toBe(1)
  })

  it('still respects the fence when escalation is NOT opted in', async () => {
    writeSnapshotWith('2026-08-21T13-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['x'] } } }))
    setLastGood('2026-08-21T13-00-00-000Z')
    setLive(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['x', 'bad'] } } }))
    setFailures(1)
    await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1 })
    setFailures(1)
    const out = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1 })
    expect(out.triggered).toBe(false)
    expect(out.restored).toBe(false)
  })

  it('stops escalating when no OLDER valid snapshot exists (no progress -> stop)', async () => {
    // Only two snapshots: ts2 (last-good) and ts1 (older).
    writeSnapshotWith('2026-08-21T23-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['m', 'n'] } } }))
    writeSnapshotWith('2026-08-21T22-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['m'] } } }))
    setLastGood('2026-08-21T23-00-00-000Z')
    setLive(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['m', 'n', 'bad'] } } }))
    setFailures(1)
    await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(readState(home).profiles['web'].rollbackEscalation?.offset).toBe(0)
    // First escalation -> ts1 (offset 1).
    setFailures(1)
    const out2 = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(out2.triggered).toBe(true)
    expect(out2.offset).toBe(1)
    expect(JSON.parse(liveConfig()).dsh.profile.bundles).toEqual(['m'])
    // No older snapshot left: the NEXT failure must stop (fence respected again).
    setFailures(1)
    const out3 = await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(out3.triggered).toBe(false)
    expect(out3.restored).toBe(false)
  })

  it('recordSuccess clears the escalation walk-back state on a genuine success', async () => {
    writeSnapshotWith('2026-08-21T09-00-00-000Z', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['q'] } } }))
    setLastGood('2026-08-21T09-00-00-000Z')
    setLive(JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['q', 'bad'] } } }))
    setFailures(1)
    await maybeRollback({ home, profile: 'web', kind: 'ui', autoConfirm: true, log, threshold: 1, allowEscalation: true })
    expect(readState(home).profiles['web'].rollbackEscalation).toBeDefined()
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'))
    const after = readState(home)
    expect(after.profiles['web'].rollbackEscalation).toBeUndefined()
    expect(after.profiles['web'].rolledBackAt).toBeUndefined()
  })
})
