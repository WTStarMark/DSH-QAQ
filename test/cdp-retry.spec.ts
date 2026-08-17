import { describe, it, expect, vi } from 'vitest'
import type { CdpSession } from '../src/cdp.ts'
import { detectUi } from '../src/detector-ui.ts'

/**
 * The retry-on-debug-port-collision branch of `detectUi` (random ports in the
 * 9000-9899 band can collide with a foreign process) spawns a real headless
 * browser via `launchSession`. Here we mock `launchSession` to throw on the
 * first attempt (simulating a collision) and hand back a fake live session on
 * the second, so the retry loop is exercised without ever driving Chrome.
 */
const { launchMock, closeMock } = vi.hoisted(() => ({
  launchMock: vi.fn<(o: unknown) => Promise<CdpSession>>(),
  closeMock: vi.fn(() => Promise.resolve()),
}))

vi.mock('../src/cdp.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cdp.ts')>()
  return {
    ...actual,
    launchSession: (...args: unknown[]) => launchMock(...args as [never]),
  }
})

function fakeHealthySession(): CdpSession {
  return {
    evaluate: async () => ({ bodyText: 'chat area', hasComposer: true, isBootPage: false }),
    close: closeMock,
  }
}

describe('detectUi port-collision retry', () => {
  it('retries with a fresh random port when launchSession throws (no browser reuse)', async () => {
    launchMock
      .mockImplementationOnce(async () => { throw new Error('browser did not expose CDP on port 9123') })
      .mockImplementationOnce(async () => fakeHealthySession())

    const v = await detectUi('http://127.0.0.1:3080', 5000, 0)
    expect(v.ok).toBe(true)
    expect(v.kind).toBe('ok')
    // The first (colliding) attempt must have been retried, not swallowed as fatal.
    expect(launchMock).toHaveBeenCalledTimes(2)
    // Every successful session is closed after probing.
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retry budget when every launch collides', async () => {
    launchMock.mockClear()
    closeMock.mockClear()
    launchMock.mockImplementation(async () => { throw new Error('no Chrome/Chromium found to drive the UI detector') })

    await expect(detectUi('http://127.0.0.1:3080', 100, 0)).rejects.toThrow(/no Chrome|no Chromium/i)
    // A missing browser is not retried: the "port>0 OR no browser" guard rethrows.
    expect(launchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when an explicit port is passed (port > 0 means "use this one")', async () => {
    launchMock.mockClear()
    closeMock.mockClear()
    launchMock.mockImplementation(async () => { throw new Error('browser did not expose CDP on port 9123') })

    await expect(detectUi('http://127.0.0.1:3080', 100, 9123)).rejects.toThrow(/CDP on port/)
    // Explicit port collides: exactly one attempt, no retry.
    expect(launchMock).toHaveBeenCalledTimes(1)
  })
})
