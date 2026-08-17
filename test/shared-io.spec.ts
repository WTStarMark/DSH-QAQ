import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sharedDir, ensureSharedDir, writeSharedJson, readPluginHeartbeat,
  readPluginState, isHeartbeatFresh, pushEvent, readEvents, HEARTBEAT_FILE,
  readPluginConnection, PLUGIN_INVENTORY_FILE, PLUGIN_STATE_FILE,
} from '../src/shared-io.ts'
import { Logger } from '../src/log.ts'

let home = ''
let log: Logger
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-shared-')); log = new Logger(home, 'qaq', 'test') })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('shared-io channel', () => {
  it('creates the shared directory lazily', () => {
    const dir = ensureSharedDir(home)
    const expected = join(home, '.qaq', 'shared')
    expect(dir).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  it('writes and reads a heartbeat atomically', () => {
    writeSharedJson(home, HEARTBEAT_FILE, { ts: new Date().toISOString(), pid: 1234, profile: 'web', port: 3081, version: 1 })
    const hb = readPluginHeartbeat(home)
    expect(hb).not.toBeNull()
    expect(hb!.pid).toBe(1234)
    expect(hb!.port).toBe(3081)
    expect(hb!.profile).toBe('web')
  })

  it('a tight maxAge treats an earlier mtime as stale', async () => {
    writeSharedJson(home, HEARTBEAT_FILE, { ts: new Date().toISOString(), pid: 1, port: 1, version: 1 })
    await new Promise(r => setTimeout(r, 30))
    expect(readPluginHeartbeat(home, 0)).not.toBeNull()
    expect(readPluginHeartbeat(home, 1)).toBeNull()
  })

  it('isHeartbeatFresh reflects recency', () => {
    writeSharedJson(home, HEARTBEAT_FILE, { ts: new Date().toISOString(), pid: 1, port: 1, version: 1 })
    expect(isHeartbeatFresh(home, 0)).toBe(true)
  })

  it('plugin-state read returns null when absent', () => {
    expect(readPluginState(home, 0)).toBeNull()
  })

  it('appends and reads events with a cursor', () => {
    pushEvent(home, 'watch-failed', 'web', { kind: 'ui', error: 'red' })
    const all = readEvents(home, 0)
    expect(all.length).toBeGreaterThanOrEqual(1)
    const last = all[all.length - 1]
    expect(last.kind).toBe('watch-failed')
    expect(last.profile).toBe('web')
    expect(readEvents(home, last.seq)).toEqual([])
  })

  it('readPluginConnection aggregates heartbeat+inventory+state into a real connection state', () => {
    const dir = sharedDir(home)
    // Heartbeat only → connecting (not yet fully wired).
    writeSharedJson(home, HEARTBEAT_FILE, { ts: new Date().toISOString(), pid: 111, profile: 'web', port: 3080, version: 1 })
    let c = readPluginConnection(home)
    expect(c.state).toBe('connecting')
    // Add the inventory + state → connected.
    writeSharedJson(home, PLUGIN_INVENTORY_FILE, { ts: new Date().toISOString(), profile: 'web', count: 3, entries: [] })
    writeSharedJson(home, PLUGIN_STATE_FILE, { ts: new Date().toISOString(), profile: 'web', settled: true })
    c = readPluginConnection(home)
    expect(c.state).toBe('connected')
    expect(c.pid).toBe(111)
    expect(c.port).toBe(3080)
    expect(c.pluginCount).toBe(3)
    expect(c.settled).toBe(true)
  })
})
