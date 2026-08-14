import { describe, it, expect } from 'vitest'
import { classifyDom, parseFailedEntries, extractFailureDetail, FAILED_MARKER } from '../src/detector-ui.ts'

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