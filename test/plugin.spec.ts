import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set the plugin's env (DSH home + heartbeat interval) BEFORE dynamically
// importing the plugin, because it reads QAQQ_HEARTBEAT_INTERVAL_MS at module
// top. The interval override keeps the test fast (production default is 5s).
const home = mkdtempSync(join(tmpdir(), 'qaq-plugin-'))
process.env.DSH_HOME = home
process.env.QAQ_HEARTBEAT_INTERVAL_MS = '60'

beforeAll(() => {
  mkdirSync(join(home, '.qaq', 'shared'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-qaq'] } } }))
})
afterAll(() => {
  delete process.env.DSH_HOME
  delete process.env.QAQ_HEARTBEAT_INTERVAL_MS
  rmSync(home, { recursive: true, force: true })
})

/** A minimal cordis-like Context exposing just what the plugin uses. `session`
 *  listeners (registered via ctx.on('session/event', cb)) are stashed so a test
 *  can synthesize a user conversation and assert the true-backup behaviour. */
function fakeCtx(): any {
  // The loader exposes entries() exactly like Cordis (used by the plugin to push
  // the authoritative inventory: entryId, moduleName, disabled, fiber.state).
  const loader = {
    await: () => Promise.resolve({ ok: true }),
    entries: () => [
      { id: 'dsh-base', options: { name: '@deepseek-ai/dsh-base' }, disabled: false, fiber: { state: 2 } },
      { id: 'dsh-session', options: { name: '@deepseek-ai/dsh-session' }, disabled: false, fiber: { state: 2 } },
      { id: 'dsh-pwsh-sandbox', options: { name: '@deepseek-ai/dsh-pwsh-sandbox' }, disabled: false, fiber: { state: 3 } },
      { id: 'grp', options: { name: 'group', group: true }, disabled: false },
    ],
  }
  const listeners = new Map<string, Array<(...a: any[]) => void>>()
  return {
    get: (k: string): any => (k === 'loader' ? loader : k === 'webServer' ? { port: 4399 } : undefined),
    on: (event: string, listener: (...a: any[]) => void): (() => void) => {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
      return () => { /* best effort */ }
    },
    _emit: (event: string, ...args: any[]): void => {
      for (const l of listeners.get(event) ?? []) try { l(...args) } catch { /* ignore */ }
    },
  }
}

describe('dsh-qaq presence heartbeat', () => {
  it('refreshes the heartbeat periodically while DSH is alive (expiry regression)', async () => {
    // Dynamic import so the heartbeat interval override above is in effect.
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    const { HEARTBEAT_FILE } = await import('../src/shared-io.ts')
    apply(fakeCtx())
    const hbFile = join(home, '.qaq', 'shared', HEARTBEAT_FILE)

    // First write happens synchronously inside apply(); read its ts.
    const first = JSON.parse(readFileSync(hbFile, 'utf8')) as { ts: string; port?: number }
    expect(first.port).toBe(4399)

    // Wait > 2 intervals (60ms each), then the heartbeat ts must have advanced —
    // i.e. the plugin actually re-writes it, keeping it fresh past any single
    // read. This is the exact path that was broken (no periodic writer), silently
    // defeating `qaq watch` discovery for any DSH up longer than 15s.
    await new Promise((res) => setTimeout(res, 200))
    const later = JSON.parse(readFileSync(hbFile, 'utf8')) as { ts: string }
    expect(Date.parse(later.ts)).toBeGreaterThan(Date.parse(first.ts))
  })

  it('pushes the authoritative plugin inventory from the Cordis loader (groups skipped, enabled/phase real)', async () => {
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    const { PLUGIN_INVENTORY_FILE } = await import('../src/shared-io.ts')
    // Make the inventory settle: apply() writes it once synchronously and again
    // on the loader's settle promise; reading after a short pause is stable.
    apply(fakeCtx())
    await new Promise((res) => setTimeout(res, 80))
    const inv = JSON.parse(readFileSync(join(home, '.qaq', 'shared', PLUGIN_INVENTORY_FILE), 'utf8')) as {
      count: number; entries: { entryId: string; moduleName?: string; enabled: boolean; fiberPhase?: string | null }[]
    }
    // Group entries are skipped; only the 3 real plugins are reported.
    expect(inv.count).toBe(3)
    expect(inv.entries.some((e) => e.moduleName === '@deepseek-ai/dsh-base')).toBe(true)
    // Enabled comes straight from !entry.disabled (not inferred from files).
    const pwsh = inv.entries.find((e) => e.moduleName === '@deepseek-ai/dsh-pwsh-sandbox')!
    expect(pwsh.enabled).toBe(true)
    // fiberPhase reflects the loader state (ACTIVE=2→active, FAILED=3→failed).
    expect(inv.entries.find((e) => e.moduleName === '@deepseek-ai/dsh-base')!.fiberPhase).toBe('active')
    expect(pwsh.fiberPhase).toBe('failed')
  })

  it('refreshes the plugin inventory periodically (keeps the external "connected" state from degrading to connecting)', async () => {
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    const { readPluginInventory } = await import('../src/shared-io.ts')
    apply(fakeCtx())
    await new Promise((res) => setTimeout(res, 60))
    const first = readPluginInventory(home, 99999)
    expect(first).not.toBeNull()
    // Wait > 2 heartbeat intervals (60ms each), then the inventory ts must have
    // advanced — i.e. the plugin re-writes it periodically alongside the
    // heartbeat, so all connectivity channels stay fresh (the degrades-to-
    // connecting regression).
    await new Promise((res) => setTimeout(res, 160))
    const later = readPluginInventory(home, 99999)
    expect(later).not.toBeNull()
    expect(Date.parse(later!.ts)).toBeGreaterThan(Date.parse(first!.ts))
  })
})

describe('dsh-qaq true backup (user-conversation gate)', () => {
  it('isUserConversation accepts only a real human user/message', async () => {
    const { isUserConversation } = await import('../packages/dsh-qaq/src/index.ts')
    // Genuine human prompt.
    expect(isUserConversation({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    // Plugin-injected context is NOT a user conversation.
    expect(isUserConversation({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' } } })).toBe(false)
    // Derived / model / tool messages are not user conversations.
    expect(isUserConversation({ type: 'assistant/message', data: { source: { kind: 'model', provider: 'x', model: 'x' } } })).toBe(false)
    expect(isUserConversation({ type: 'tool/result', data: {} })).toBe(false)
    // Missing/empty guards.
    expect(isUserConversation(null)).toBe(false)
    expect(isUserConversation(undefined)).toBe(false)
  })

  it('a plain host settle does NOT write last-good (never records a broken boot)', async () => {
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    // Wait for any prior test's settle writes to land first, then timestamp the
    // current latest-good so we can detect a NEW snapshot write below.
    await new Promise((res) => setTimeout(res, 80))
    const latestGoodDir = join(home, '.qaq', 'latest-good')
    const beforeTs = existsSync(join(latestGoodDir, 'manifest.json'))
      ? (JSON.parse(readFileSync(join(latestGoodDir, 'manifest.json'), 'utf8')) as { ts: string }).ts
      : null

    apply(fakeCtx())
    // settle resolves immediately; give the .then a beat to run.
    await new Promise((res) => setTimeout(res, 120))

    const manifest = existsSync(join(latestGoodDir, 'manifest.json'))
      ? (JSON.parse(readFileSync(join(latestGoodDir, 'manifest.json'), 'utf8')) as { ts: string }).ts
      : null
    // No user conversation happened → last-good must be unchanged (either still
    // absent, or its timestamp untouched by this boot).
    expect(manifest).toBe(beforeTs)
  })

  it('writes last-good only after a real user conversation', async () => {
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    const ctx = fakeCtx()
    apply(ctx)
    await new Promise((res) => setTimeout(res, 80))

    const latestGoodDir = join(home, '.qaq', 'latest-good')
    const beforeExists = existsSync(join(latestGoodDir, 'manifest.json'))

    // Fire a plugin-inject (must NOT snapshot).
    ctx._emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'ctx-inject' } }, seq: 1, time: 1 })
    await new Promise((res) => setTimeout(res, 30))
    const afterInject = existsSync(join(latestGoodDir, 'manifest.json'))
    expect(afterInject).toBe(beforeExists)

    // Now fire a genuine human message → must snapshot.
    ctx._emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [] }, seq: 2, time: 2 })
    await new Promise((res) => setTimeout(res, 50))
    const manifest = existsSync(join(latestGoodDir, 'manifest.json'))
      ? (JSON.parse(readFileSync(join(latestGoodDir, 'manifest.json'), 'utf8')) as { ts: string; profile: string }).ts
      : null
    expect(manifest).not.toBeNull()
    // The snapshot must carry the profile manifest.
    const manifestObj = JSON.parse(readFileSync(join(latestGoodDir, 'manifest.json'), 'utf8')) as { profile: string }
    expect(manifestObj.profile).toBe('web')
  })
})

describe('dsh-qaq loaded-config fingerprint (guard plan A)', () => {
  it('reports a loadedFingerprint equal to the CLI-side config fingerprint', async () => {
    const { apply } = await import('../packages/dsh-qaq/src/index.ts')
    const { PLUGIN_STATE_FILE } = await import('../src/shared-io.ts')
    const { configFingerprint } = await import('../src/verify-config.ts')
    // The profile package.json is seeded in beforeAll (bundles: dsh-base, dsh-qaq).
    const cliFp = configFingerprint(join(home, 'profiles', 'web'))
    apply(fakeCtx())
    await new Promise((res) => setTimeout(res, 80))
    const st = JSON.parse(readFileSync(join(home, '.qaq', 'shared', PLUGIN_STATE_FILE), 'utf8')) as { loadedFingerprint?: string }
    expect(typeof st.loadedFingerprint).toBe('string')
    // The two sides must compute the identical fingerprint (they share the
    // algorithm; a drift here would make plan A refuse/allow wrongly).
    expect(st.loadedFingerprint).toBe(cliFp)
  })
})
