import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeSnapshotText, restoreSnapshotText, listHotSnapshots, removeHotSnapshot,
  entryInInventory, isDshOnline, verifyPatchInsertApplied,
  resolveClientBundlePaths, watchClientBundles,
  resolveWebDistDir, watchRestartTriggers,
  hotSnapshotsDir, type HotWatchEvent, type ClientBundleInfo,
} from '../src/hot-update.ts'
import { writeSharedJson } from '../src/shared-io.ts'
import { profileDir } from '../src/paths.ts'

let home = ''
const profile = 'web'
const pr = (): string => profileDir(home, profile)

/** A minimal client plugin package (dsh.client + exports["./client"]). */
function writeClientPlugin(pkgDir: string, name: string, bundleContent = 'window.__PLUGIN__ = 1\n'): string {
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { client: { platform: 'web' } },
    exports: { './client': { default: './lib/client.js' } },
  }))
  const bundle = join(pkgDir, 'lib', 'client.js')
  writeFileSync(bundle, bundleContent, 'utf8')
  return bundle
}

/** A bundle-only plugin (no client half — must NOT be watched). */
function writeBundlePlugin(pkgDir: string, name: string): void {
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert:\n    - id: ' + name + '\n      name: ' + name + '\n')
}

/** Write a fake live heartbeat + inventory (dsh-qaq shape). */
function fakeLive(entries: { entryId: string; moduleName?: string; enabled: boolean; fiberPhase?: string | null }[], port = 3080): void {
  writeSharedJson(home, 'plugin-heartbeat.json', { ts: new Date().toISOString(), pid: 4242, profile, port, version: 1 })
  writeSharedJson(home, 'plugin-inventory.json', { ts: new Date().toISOString(), profile, settled: true, count: entries.length, entries })
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-hot-'))
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })
beforeEach(() => {
  rmSync(join(home, '.qaq'), { recursive: true, force: true })
  rmSync(pr(), { recursive: true, force: true })
  mkdirSync(join(home, '.qaq', 'shared'), { recursive: true })
  mkdirSync(pr(), { recursive: true })
})

describe('hot snapshot storage', () => {
  it('writes, lists, restores and removes a snapshot (restore bumps mtime)', () => {
    const file = join(pr(), 'lib', 'client.js')
    mkdirSync(join(pr(), 'lib'), { recursive: true })
    writeFileSync(file, 'old content', 'utf8')
    const before = statSync(file).mtimeMs
    const id = writeSnapshotText(home, 'ui-theme/client.js', 'old content')
    expect(id).not.toBeNull()
    expect(listHotSnapshots(home)).toContain(id!)

    // New content lands; restore must bring the old text back AND change mtime
    // (so DSH's client-hmr stat-poll re-detects the change).
    writeFileSync(file, 'new content', 'utf8')
    expect(restoreSnapshotText(home, id!, 'ui-theme/client.js', file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('old content')
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(before)

    removeHotSnapshot(home, id!)
    expect(listHotSnapshots(home)).not.toContain(id!)
  })

  it('restore of a missing snapshot fails cleanly', () => {
    expect(restoreSnapshotText(home, 'nope', 'x/client.js', join(pr(), 'x.js'))).toBe(false)
  })
})

describe('resolveClientBundlePaths (what DSH client-hmr watches)', () => {
  it('resolves only enabled plugins that have a client half', () => {
    // A client plugin in the profile node_modules, enabled via the bundle list.
    writeClientPlugin(join(pr(), 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme'), '@deepseek-ai/dsh-client-ui-theme')
    // A client plugin enabled via cordis.patch.yml (the precise-cache shape),
    // installed in the shared pool.
    writeClientPlugin(join(home, 'profiles', 'node_modules', 'dsh-precise-cache'), 'dsh-precise-cache')
    // A bundle-only plugin — must NOT appear.
    writeBundlePlugin(join(pr(), 'node_modules', 'dsh-qaq'), 'dsh-qaq')

    writeFileSync(join(pr(), 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-client-ui-theme', 'dsh-qaq'] } },
    }))
    writeFileSync(join(pr(), 'cordis.patch.yml'), '- insert:\n    - id: precise-cache\n      name: dsh-precise-cache\n')

    const found = resolveClientBundlePaths({ home, profile })
    const names = found.map((b) => b.name).sort()
    expect(names).toEqual(['@deepseek-ai/dsh-client-ui-theme', 'dsh-precise-cache'])
    const theme = found.find((b) => b.name === '@deepseek-ai/dsh-client-ui-theme')!
    expect(theme.bundlePath).toBe(join(pr(), 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'))
  })

  it('skips uninstalled plugins and non-client packages', () => {
    // Enabled in bundles but no module anywhere → skipped, not thrown.
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({
      name: 'x', dsh: { profile: { bundles: ['@deepseek-ai/dsh-ghost'] } },
    }))
    expect(resolveClientBundlePaths({ home, profile })).toEqual([])
  })
})

describe('entryInInventory + isDshOnline (live dsh-qaq channels)', () => {
  it('matches entries by moduleName, entryId, or short id', () => {
    fakeLive([
      { entryId: 'theme', moduleName: '@deepseek-ai/dsh-client-ui-theme', enabled: true, fiberPhase: 'active' },
      { entryId: 'precise-cache', moduleName: 'dsh-precise-cache', enabled: false, fiberPhase: 'failed' },
    ])
    expect(isDshOnline(home)).toBe(true)
    expect(entryInInventory(home, '@deepseek-ai/dsh-client-ui-theme')?.enabled).toBe(true)
    expect(entryInInventory(home, 'theme')?.enabled).toBe(true) // short id
    expect(entryInInventory(home, 'dsh-precise-cache')?.enabled).toBe(false)
    expect(entryInInventory(home, 'dsh-unknown')).toBeNull()
  })

  it('isDshOnline is false without a fresh heartbeat', () => {
    expect(isDshOnline(home)).toBe(false)
    expect(entryInInventory(home, 'x')).toBeNull()
  })
})

describe('verifyPatchInsertApplied (channel 2 — config-layer hot verification)', () => {
  it('returns offline when DSH is not reporting', async () => {
    const r = await verifyPatchInsertApplied({ home, name: 'dsh-precise-cache', wantEnabled: true, waitMs: 50 })
    expect(r.applied).toBeNull()
    expect(r.reason).toBe('offline')
  })

  it('confirms an enabled patch-insert plugin landed on the running DSH', async () => {
    fakeLive([{ entryId: 'precise-cache', moduleName: 'dsh-precise-cache', enabled: true, fiberPhase: 'active' }])
    const r = await verifyPatchInsertApplied({ home, name: 'dsh-precise-cache', wantEnabled: true, waitMs: 500, intervalMs: 50 })
    expect(r.applied).toBe(true)
  })

  it('reports not-applied when the inventory never reflects the change', async () => {
    fakeLive([{ entryId: 'precise-cache', moduleName: 'dsh-precise-cache', enabled: true, fiberPhase: 'active' }])
    const r = await verifyPatchInsertApplied({ home, name: 'dsh-precise-cache', wantEnabled: false, waitMs: 300, intervalMs: 50 })
    expect(r.applied).toBe(false)
    expect(r.detail).toBeTruthy()
  })

  it('a disable is applied when the entry leaves the inventory', async () => {
    fakeLive([])
    const r = await verifyPatchInsertApplied({ home, name: 'dsh-precise-cache', wantEnabled: false, waitMs: 200, intervalMs: 50 })
    expect(r.applied).toBe(true)
  })
})

describe('watchClientBundles (channel 1 — bundle hot-swap guard)', () => {
  it('verifies a bundle change, and rolls back to the pre-change snapshot when the swap breaks the UI', async () => {
    // One watched client plugin, enabled via the bundle list.
    const bundle = writeClientPlugin(join(pr(), 'node_modules', 'dsh-ui-thing'), 'dsh-ui-thing', 'v1')
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['dsh-ui-thing'] } } }))

    const events: HotWatchEvent[] = []
    // verify fails on the NEW content, then succeeds after the rollback restore.
    let verifyCalls = 0
    const verify = async (_b: ClientBundleInfo): Promise<boolean> => {
      verifyCalls += 1
      return verifyCalls >= 2
    }
    const dispose = watchClientBundles({
      home, profile, pollMs: 40, settleMs: 40, verify, onEvent: (e) => events.push(e),
    })

    // Give the watcher one baseline pass.
    await new Promise((r) => setTimeout(r, 120))
    writeFileSync(bundle, 'v2-broken', 'utf8')
    await new Promise((r) => setTimeout(r, 400))

    // The bundle must have been restored to the pre-change content.
    expect(readFileSync(bundle, 'utf8')).toBe('v1')
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('changed')
    expect(kinds).toContain('rollback')
    expect(kinds).not.toContain('rollback-failed')
    // A pre-change snapshot was retained under hot-snapshots.
    expect(existsSync(hotSnapshotsDir(home))).toBe(true)

    dispose()
  })

  it('emits verified when the swap lands cleanly, with no rollback', async () => {
    const bundle = writeClientPlugin(join(pr(), 'node_modules', 'dsh-ui-thing'), 'dsh-ui-thing', 'v1')
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['dsh-ui-thing'] } } }))
    const events: HotWatchEvent[] = []
    const dispose = watchClientBundles({ home, profile, pollMs: 40, settleMs: 40, verify: async () => true, onEvent: (e) => events.push(e) })

    await new Promise((r) => setTimeout(r, 120))
    writeFileSync(bundle, 'v2-ok', 'utf8')
    await new Promise((r) => setTimeout(r, 300))

    expect(events.some((e) => e.kind === 'changed')).toBe(true)
    expect(events.some((e) => e.kind === 'verified')).toBe(true)
    expect(events.some((e) => e.kind === 'rollback')).toBe(false)
    expect(readFileSync(bundle, 'utf8')).toBe('v2-ok') // not rolled back
    dispose()
  })
})

describe('watchRestartTriggers (channel 3 — pseudo-update)', () => {
  it('fires onTrigger after the bundle list changes (debounced)', async () => {
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['a'] } } }))
    const reasons: string[] = []
    const dispose = watchRestartTriggers({
      home, profile, watchBundles: true, watchDist: false,
      pollMs: 30, debounceMs: 80, onTrigger: (reason) => reasons.push(reason),
    })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['a', 'b'] } } }))
    await new Promise((r) => setTimeout(r, 250))
    expect(reasons).toEqual(['bundles'])
    dispose()
  })

  it('fires onTrigger when the web dist is rebuilt', async () => {
    // A fake checkout with a built web frontend dist.
    const checkout = join(home, 'fake-dsh')
    const dist = join(checkout, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), 'v1')
    expect(resolveWebDistDir({ checkout })).toBe(dist)
    expect(resolveWebDistDir({ checkout: undefined })).toBeNull()

    const reasons: string[] = []
    const dispose = watchRestartTriggers({
      home, profile, checkout, watchBundles: false, watchDist: true,
      pollMs: 30, debounceMs: 80, onTrigger: (reason) => reasons.push(reason),
    })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(dist, 'index.html'), 'v2-rebuilt')
    await new Promise((r) => setTimeout(r, 250))
    expect(reasons).toEqual(['dist'])
    dispose()
  })

  it('does not fire when nothing changes', async () => {
    writeFileSync(join(pr(), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['a'] } } }))
    const reasons: string[] = []
    const dispose = watchRestartTriggers({
      home, profile, watchBundles: true, watchDist: false,
      pollMs: 30, debounceMs: 60, onTrigger: (reason) => reasons.push(reason),
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(reasons).toEqual([])
    dispose()
  })
})
