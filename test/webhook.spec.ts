import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverWebhooks, resolveWebhooks, defaultWebhookHome } from '../src/webhook.ts'

const servers: Server[] = []
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
})

/** Spin up a local HTTP server that records the last POST body. */
function captureServer(): Promise<{ port: number; urls: string[]; bodies: string[] }> {
  return new Promise((resolve) => {
    const urls: string[] = []
    const bodies: string[] = []
    const s = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += String(d) })
      req.on('end', () => {
        urls.push(req.url ?? '')
        bodies.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    servers.push(s)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      resolve({ port, urls, bodies })
    })
  })
}

describe('deliverWebhooks (best-effort HTTP delivery)', () => {
  it('short-circuits (no-op) when no webhooks are configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qaq-wh-empty-'))
    try {
      const n = await deliverWebhooks(home, [], { kind: 'boot-failed', ts: new Date().toISOString() })
      expect(n).toBe(0)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('posts the JSON event body to every configured URL and counts deliveries', async () => {
    const { port, urls, bodies } = await captureServer()
    const n = await deliverWebhooks('', [`http://127.0.0.1:${port}/a`, `http://127.0.0.1:${port}/b`], {
      kind: 'rollback-applied', ts: '2026-01-01T00:00:00Z', profile: 'web', data: { rolledBack: true },
    })
    expect(n).toBe(2)
    expect(urls).toContain('/a')
    expect(urls).toContain('/b')
    for (const b of bodies) {
      const parsed = JSON.parse(b)
      expect(parsed.kind).toBe('rollback-applied')
      expect(parsed.profile).toBe('web')
    }
  })

  it('rejects an unsupported protocol without crashing the caller', async () => {
    const n = await deliverWebhooks('', ['ftp://example.com/hook'], { kind: 'boot-failed', ts: 'x' })
    // Deliveries that fail (unsupported protocol) are best-effort: 0 delivered, no throw.
    expect(n).toBe(0)
  })
})

describe('resolveWebhooks sources', () => {
  it('reads a single-string webhooks.json file', () => {
    const home = mkdtempSync(join(tmpdir(), 'qaq-wh-file-'))
    try {
      mkdirSync(join(home, '.qaq'), { recursive: true })
      writeFileSync(join(home, '.qaq', 'webhooks.json'), JSON.stringify('http://file.example/hook'), 'utf8')
      const targets = resolveWebhooks(home)
      expect(targets.map(t => t.url)).toContain('http://file.example/hook')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('reads an array config with names and filters invalid entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'qaq-wh-arr-'))
    try {
      mkdirSync(join(home, '.qaq'), { recursive: true })
      writeFileSync(join(home, '.qaq', 'webhooks.json'), JSON.stringify([
        { url: 'http://good.example/hook', name: 'ops' },
        { name: 'no-url' },
        'http://str.example/hook',
      ]), 'utf8')
      const targets = resolveWebhooks(home)
      expect(targets.map(t => t.name)).toContain('ops')
      expect(targets.map(t => t.url)).toContain('http://str.example/hook')
      expect(targets.some(t => t.url === undefined)).toBe(false)
      expect(targets.some(t => t.name === 'no-url')).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('is robust to a corrupt webhooks.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'qaq-wh-bad-'))
    try {
      mkdirSync(join(home, '.qaq'), { recursive: true })
      writeFileSync(join(home, '.qaq', 'webhooks.json'), '{not json', 'utf8')
      expect(resolveWebhooks(home)).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('defaultWebhookHome', () => {
  it('falls back to ~/.dsh when DSH_HOME is unset', () => {
    const prev = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      const h = defaultWebhookHome()
      expect(h.endsWith('.dsh')).toBe(true)
    } finally { if (prev !== undefined) process.env.DSH_HOME = prev }
  })
})