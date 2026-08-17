import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshContext, profileBasename, describeDsh } from '../src/dsh-context.ts'

// Each vitest spec file runs in its own worker, so mutating DSH_HOME here is
// isolated and never touches the real ~/.dsh or a running DSH on :3080.
let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-dshctx-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('resolveDshContext', () => {
  it('resolves an idle profile with no external DSH up', () => {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const ctx = resolveDshContext({ profile: 'web', cwd: home })
    expect(ctx.home).toBe(home)
    expect(ctx.profile).toBe('web')
    expect(ctx.profileDir).toBe(join(home, 'profiles', 'web'))
    expect(ctx.poolDir).toBe(join(home, 'profiles', 'node_modules'))
    expect(ctx.processUp).toBe(false)
    expect(ctx.connection.state).toBe('disconnected')
    // The home must always be reported regardless of any discovered checkout.
    expect(ctx.checkoutSource).toMatch(/^(cwd|sibling|env|none)$/)
  })

  it('reports an external DSH as up via a fresh plugin heartbeat', () => {
    mkdirSync(join(home, '.qaq', 'shared'), { recursive: true })
    const shared = join(home, '.qaq', 'shared')
    // Heartbeat + inventory + state must be fresh for a "connected" state.
    writeFileSync(join(shared, 'plugin-heartbeat.json'), JSON.stringify({ ts: new Date().toISOString(), pid: 4242, profile: 'web', port: 3080, version: 1 }))
    writeFileSync(join(shared, 'plugin-state.json'), JSON.stringify({ ts: new Date().toISOString(), profile: 'web', settled: true }))
    writeFileSync(join(shared, 'plugin-inventory.json'), JSON.stringify({ ts: new Date().toISOString(), profile: 'web', settled: true, count: 1, entries: [] }))
    const ctx = resolveDshContext({ profile: 'web', cwd: home })
    expect(ctx.processUp).toBe(true)
    expect(ctx.processPid).toBe(4242)
    expect(ctx.processPort).toBe(3080)
    expect(ctx.connection.state).toBe('connected')
  })

  it('profileBasename returns the trailing profile directory name', () => {
    const ctx = resolveDshContext({ profile: 'beta', cwd: home })
    expect(profileBasename(ctx)).toBe('beta')
  })

  it('describeDsh names home and reports the process is down', () => {
    const ctx = resolveDshContext({ profile: 'web', cwd: home })
    expect(describeDsh(ctx)).toContain('home=' + home)
    expect(describeDsh(ctx)).toContain('process=down')
  })
})
