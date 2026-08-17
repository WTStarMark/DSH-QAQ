import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWatchTarget } from '../src/watch.ts'
import { resolveWebhooks } from '../src/webhook.ts'
import { Logger } from '../src/log.ts'

let root = ''
let log: Logger
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'qaq-watch-')); mkdirSync(root, { recursive: true }); log = new Logger(root, 'qaq', 'test') })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function homeFor(name: string): string {
  const h = join(root, name)
  mkdirSync(join(h, 'profiles'), { recursive: true })
  return h
}

describe('watch target resolution', () => {
  it('prefers an explicit attach port', () => {
    const h = homeFor('attach')
    const t = resolveWatchTarget({ home: h, attachPort: 3091, profile: 'web' }, log)
    expect(t).not.toBeNull()
    expect(t!.source).toBe('attach')
    expect(t!.port).toBe(3091)
  })

  it('discovers the port from the plugin heartbeat', () => {
    const h = homeFor('hb')
    writeShared(h, 42)
    const t = resolveWatchTarget({ home: h, profile: 'web' }, log)
    expect(t).not.toBeNull()
    expect(t!.source).toBe('heartbeat')
    expect(t!.port).toBe(3081)
  })

  it('returns null when neither attach nor heartbeat present', () => {
    const h = homeFor('none')
    expect(resolveWatchTarget({ home: h, profile: 'web' }, log)).toBeNull()
  })
})

function writeShared(home: string, pid: number): void {
  const w = require('../src/shared-io.ts').writeSharedJson
  const HEARTBEAT_FILE = require('../src/shared-io.ts').HEARTBEAT_FILE
  w(home, HEARTBEAT_FILE, { ts: new Date().toISOString(), pid, profile: 'web', port: 3081, version: 1 })
}

describe('webhook resolution', () => {
  it('merges CLI flags and env var, deduped by URL', () => {
    const urls = resolveWebhooks(root, ['http://cli.example/hook', 'http://cli.example/hook'], { QAQ_WEBHOOK_URL: 'http://env.example/hook,http://a.example/hook' } as any)
    const set = urls.map(u => u.url)
    expect(set).toContain('http://cli.example/hook')
    expect(set).toContain('http://env.example/hook')
    expect(new Set(set).size).toBe(set.length)
  })
})
