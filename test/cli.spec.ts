import { describe, it, expect, vi } from 'vitest'

// Import the CLI after stubbing heavy side-effect deps so importing is safe:
// preflight/env, spawn, and the console entry are exercised only via functions
// the tests call, never at module load.
vi.mock('../src/env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/env.ts')>()
  return { ...actual, preflight: vi.fn(async () => ({ problems: [], command: [], cwd: '.', port: 3080, browser: 'mock' })) }
})

import { parseCli } from '../src/cli.ts'

describe('parseCli (command surface)', () => {
  it('defaults a bare invocation to dsh supervision with the web profile', () => {
    const a = parseCli(['web'])
    expect(a.mode).toBe('dsh')
    expect(a.profile).toBe('web')
    expect(a.yes).toBe(false)
  })

  it('parses --yes and --profile', () => {
    const a = parseCli(['status', '--yes', '--profile', 'beta'])
    expect(a.mode).toBe('status')
    expect(a.yes).toBe(true)
    expect(a.profile).toBe('beta')
  })

  it('maps watch with --attach falling back to --port', () => {
    const attach = parseCli(['watch', '--attach', '4001'])
    expect(attach.mode).toBe('watch')
    expect(attach.attach).toBe(4001)
    // attach = attach ?? port, so when only --port is given, attach takes it.
    const viaPort = parseCli(['watch', '--port', '3099'])
    expect(viaPort.mode).toBe('watch')
    expect(viaPort.attach).toBe(3099)
  })

  it('parses dsh web tuning flags as numbers', () => {
    const a = parseCli(['web', '--confirm-ms', '5000', '--ui-timeout', '30000', '--threshold', '2', '--cwd', '/tmp/w'])
    expect(a.confirmMs).toBe(5000)
    expect(a.uiTimeoutMs).toBe(30000)
    expect(a.threshold).toBe(2)
    expect(a.cwd).toBe('/tmp/w')
  })

  it('ignores a non-numeric numeric flag', () => {
    const a = parseCli(['web', '--port'])
    expect(a.port).toBeUndefined()
  })

  it('collects repeatable --webhook flags', () => {
    const a = parseCli(['watch', '--webhook', 'http://a/x', '--webhook', 'http://b/y'])
    expect(a.webhooks).toEqual(['http://a/x', 'http://b/y'])
  })

  it('distinguishes setup/restore/console/install-plugin modes', () => {
    expect(parseCli(['setup']).mode).toBe('setup')
    expect(parseCli(['install']).mode).toBe('setup')
    const r = parseCli(['restore', '--to', '/snap/x'])
    expect(r.mode).toBe('restore')
    expect(r.restoreTo).toBe('/snap/x')
    expect(parseCli(['tui']).mode).toBe('console')
    expect(parseCli(['gui']).mode).toBe('console')
    expect(parseCli(['install-plugin', '--profile', 'web']).mode).toBe('install-plugin')
    expect(parseCli(['help']).mode).toBe('help')
  })
})
