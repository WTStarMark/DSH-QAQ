import { describe, it, expect } from 'vitest'
import { classifyDom, parseFailedEntries, extractFailureDetail, isDefinitiveUi, FAILED_MARKER, pollUi, withConsoleErrors } from '../src/detector-ui.ts'
import type { DomSnapshot } from '../src/detector-ui.ts'
import type { CdpSession } from '../src/cdp.ts'

describe('detector-ui text classification (L3 judge)', () => {
  it('flags the real red-screen body text as failed', () => {
    const body = `HARNESS
Failed to load plugins
web boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: neverProvidedService)`
    const v = classifyDom({ bodyText: body, hasComposer: false, isBootPage: true })
    expect(v.kind).toBe('failed')
    expect(v.ok).toBe(false)
    expect(v.failureDetail).toContain('dsh-broken-theme')
    expect(v.failedEntries).toContain('dsh-broken-theme')
  })

  it('markers the "waiting for service" red screen as a DETERMINISTIC failure', () => {
    // The canonical case: an entry never activates because it waits forever on
    // a service nobody provides -> reproduces every boot -> definitive.
    const body = 'Failed to load plugins\nweb boot: 1 entry did not activate dsh-broken-theme: pending (waiting for service: neverProvidedService)'
    const v = classifyDom({ bodyText: body, hasComposer: false, isBootPage: false })
    expect(v.kind).toBe('failed')
    expect(v.definitive).toBe(true)
  })

  it('isDefinitiveUi matches only the deterministic boot markers', () => {
    expect(isDefinitiveUi('web boot: 1 entry did not activate dsh-x: pending (waiting for service: s)')).toBe(true)
    expect(isDefinitiveUi('web boot: 2 entries did not activate\nfoo: import failed')).toBe(true)
    // A generic red screen without the deterministic markers is NOT definitive.
    expect(isDefinitiveUi('Failed to load plugins')).toBe(false)
    expect(isDefinitiveUi(undefined)).toBe(false)
    expect(isDefinitiveUi('web boot: something else broke')).toBe(false)
  })

  it('calls a healthy UI with a composer healthy', () => {
    const v = classifyDom({ bodyText: 'chat area text', hasComposer: true, isBootPage: false })
    expect(v.kind).toBe('ok')
    expect(v.ok).toBe(true)
  })

  it('calls an un-settled boot page loading', () => {
    const v = classifyDom({ bodyText: 'HARNESS\nLoading plugins…', hasComposer: false, isBootPage: true })
    expect(v.kind).toBe('loading')
    expect(v.ok).toBe(false)
  })

  it('parses failed entries from a sweeper report', () => {
    const detail = 'web boot: 2 entries did not activate\nfoo-bar: pending (waiting for service: x)\n@deepseek-ai/dsh-q: import failed'
    const names = parseFailedEntries(detail)
    expect(names).toContain('foo-bar')
    expect(names).toContain('@deepseek-ai/dsh-q')
  })

  it('extracts the failure detail line', () => {
    const body = 'HARNESS\nFailed to load plugins\nweb boot: 1 entry did not activate dsh-x: pending (waiting for service: s)'
    expect(extractFailureDetail(body)).toContain('web boot:')
  })
})

describe('pollUi at-least-once probe (--confirm-ms 0 regression)', () => {
  function fakeSession(snap: DomSnapshot): CdpSession {
    return { evaluate: async () => snap, command: async () => undefined, onConsoleError: () => {}, close: async () => {} }
  }

  it('reads the DOM at least once even with a 0ms timeout (no immediate error)', async () => {
    const v = await pollUi(fakeSession({ bodyText: 'HARNESS Loading…', hasComposer: false, isBootPage: true }), 'http://127.0.0.1:3080', 0)
    expect(v.kind).toBe('loading') // not 'error': a real probe happened
    expect(v.ok).toBe(false)
  })

  it('returns ok immediately when the first probe is healthy, regardless of timeout', async () => {
    const v = await pollUi(fakeSession({ bodyText: 'chat area', hasComposer: true, isBootPage: false }), 'http://127.0.0.1:3080', 0)
    expect(v.kind).toBe('ok')
    expect(v.ok).toBe(true)
  })

  it('still fails fast on a red screen with a 0ms timeout', async () => {
    const v = await pollUi(fakeSession({ bodyText: 'Failed to load plugins', hasComposer: false, isBootPage: false }), 'http://127.0.0.1:3080', 0)
    expect(v.kind).toBe('failed')
  })
})

describe('withConsoleErrors (degradation signal attachment)', () => {
  const ok = { ok: true, kind: 'ok' as const, bodyText: 'x' }

  it('leaves the verdict untouched when no errors were sampled', () => {
    const v = withConsoleErrors(ok, [])
    expect(v.consoleErrors).toBeUndefined()
  })

  it('attaches sampled console errors to the verdict', () => {
    const v = withConsoleErrors(ok, ['Failed to load /plugins/x/client.js', 'TypeError: x is not a function'])
    expect(v.consoleErrors).toEqual(['Failed to load /plugins/x/client.js', 'TypeError: x is not a function'])
  })
})
