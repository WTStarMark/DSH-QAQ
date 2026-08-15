import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readState, writeState, emptyState, profileState, writeSnapshot,
} from '../src/store.ts'
import { maybeRollback, recordSuccess, manualBackup, DEFAULT_THRESHOLD, isUsable, diffConfig } from '../src/rollback.ts'
import { qaqDir, profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'

let home = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-rollback-')) })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })
const log = new Logger(home)

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