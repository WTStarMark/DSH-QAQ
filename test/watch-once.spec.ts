import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../src/log.ts'

/**
 * watchOnce decision paths — mock detectUi (no real Chrome) and the
 * store/rollback/webhook side effects so the pass/fail/count/rollback logic
 * itself is what is exercised.
 */
const {
  detectUiMock, incrementMock, rollbackMock, successMock, webhookMock,
} = vi.hoisted(() => ({
  detectUiMock: vi.fn(),
  incrementMock: vi.fn(),
  rollbackMock: vi.fn(),
  successMock: vi.fn(),
  webhookMock: vi.fn(),
}))

vi.mock('../src/detector-ui.ts', () => ({ detectUi: (...a: unknown[]) => detectUiMock(...a) }))
vi.mock('../src/guard.ts', () => ({ incrementFailure: (...a: unknown[]) => incrementMock(...a) }))
vi.mock('../src/rollback.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rollback.ts')>()
  return { ...actual, maybeRollback: (...a: unknown[]) => rollbackMock(...a), recordSuccess: (...a: unknown[]) => successMock(...a) }
})
vi.mock('../src/webhook.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/webhook.ts')>()
  return { ...actual, deliverWebhooks: (...a: unknown[]) => webhookMock(...a) }
})

import { watchOnce, resolveWatchTarget } from '../src/watch.ts'

let home = ''
let log: Logger
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-watchonce-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"name":"web"}')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]')
  log = new Logger(home, 'qaq', 'test')
  detectUiMock.mockReset()
  incrementMock.mockReset()
  rollbackMock.mockReset()
  successMock.mockReset()
  webhookMock.mockReset()
  // Default side-effect replies.
  rollbackMock.mockResolvedValue({ triggered: false, restored: false, badBackedUp: false })
  // deliverWebhooks must resolve (watch.ts chains .catch on its value).
  webhookMock.mockResolvedValue(0)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('watchOnce decision paths', () => {
  it('passes: healthy UI → records success, does not count', async () => {
    detectUiMock.mockResolvedValue({ ok: true, kind: 'ok', bodyText: 'chat' })
    const v = await watchOnce({ home, profile: 'web', attachPort: 3080 }, log)
    expect(v.ok).toBe(true)
    expect(v.rolledBack).toBe(false)
    expect(successMock).toHaveBeenCalled()
    expect(incrementMock).not.toHaveBeenCalled()
  })

  it('red screen → counts a ui failure and may roll back', async () => {
    detectUiMock.mockResolvedValue({ ok: false, kind: 'failed', bodyText: 'Failed to load plugins', failureDetail: 'web boot: 1 entry did not activate dsh-x: pending' })
    rollbackMock.mockResolvedValue({ triggered: true, restored: true, badBackedUp: true })
    const v = await watchOnce({ home, profile: 'web', attachPort: 3080 }, log)
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('ui')
    expect(incrementMock).toHaveBeenCalledWith(expect.any(String), 'web', 'ui', expect.any(String), expect.any(Object))
    expect(rollbackMock).toHaveBeenCalled()
    expect(v.rolledBack).toBe(true)
    // A rollback fires the webhook.
    expect(webhookMock).toHaveBeenCalled()
  })

  it('deterministic UI red screen → rollback with an effective threshold of 1 (sidecar first-hit)', async () => {
    // A host that is up but whose web UI shows a "waiting for service" red screen
    // is a deterministic config error: the sidecar must roll back on the first
    // hit instead of waiting out the general threshold.
    detectUiMock.mockResolvedValue({
      ok: false, kind: 'failed', definitive: true,
      bodyText: 'Failed to load plugins',
      failureDetail: 'web boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: neverProvidedService)',
    })
    rollbackMock.mockResolvedValue({ triggered: true, restored: true, badBackedUp: true })
    // Configure the general threshold high; the definitive override must still force 1.
    const v = await watchOnce({ home, profile: 'web', attachPort: 3080, threshold: 5 }, log)
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('ui')
    const args = rollbackMock.mock.calls[0][0] as { threshold: number }
    expect(args.threshold).toBe(1)
    expect(v.rolledBack).toBe(true)
  })

  it('unreachable host → counts a host failure', async () => {
    detectUiMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const v = await watchOnce({ home, profile: 'web', attachPort: 3080 }, log)
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('host')
    expect(incrementMock).toHaveBeenCalledWith(expect.any(String), 'web', 'host', expect.stringContaining('ECONNREFUSED'), expect.any(Object))
  })

  it('loading (unsettled) is not counted and not rolled back', async () => {
    detectUiMock.mockResolvedValue({ ok: false, kind: 'loading', bodyText: 'HARNESS loading…', hasComposer: false, isBootPage: true } as never)
    const v = await watchOnce({ home, profile: 'web', attachPort: 3080 }, log)
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('unknown')
    expect(incrementMock).not.toHaveBeenCalled()
    expect(rollbackMock).not.toHaveBeenCalled()
  })

  it('no watch target → reports without side effects', async () => {
    const v = await watchOnce({ home, profile: 'web' }, log)
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('unknown')
    expect(v.port).toBe(0)
    expect(detectUiMock).not.toHaveBeenCalled()
  })
})

describe('resolveWatchTarget with heartbeat fallback', () => {
  it('prefers --attach over the heartbeat', () => {
    const t = resolveWatchTarget({ home, profile: 'web', attachPort: 4000 }, log)
    expect(t?.source).toBe('attach')
    expect(t?.port).toBe(4000)
  })
})