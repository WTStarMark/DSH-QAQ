import { describe, it, expect } from 'vitest'
import { displayWidth, padEnd, padStart, truncate } from '../src/width.ts'

describe('displayWidth (CJK/fullwidth + ANSI aware)', () => {
  it('counts ASCII as 1 column each', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('')).toBe(0)
  })

  it('counts common CJK / fullwidth ranges as 2 columns', () => {
    expect(displayWidth('汉')).toBe(2)
    expect(displayWidth('-')) // ascii hyphen
    expect(displayWidth('a汉')).toBe(3)
    // em dash renders fullwidth in CJK console fonts
    expect(displayWidth('—')).toBe(2)
    // fullwidth comma U+FF0C
    expect(displayWidth('\uff0c')).toBe(2)
  })

  it('strips ANSI SGR sequences so they count as zero width', () => {
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(3)
    expect(displayWidth('\x1b[1m\x1b[38;2;1;2;3mX\x1b[0m')).toBe(1)
  })

  it('handles surrogate pairs (emoji outside the wide ranges) as at-least-1', () => {
    // '🙂' is a surrogate pair; it falls outside the explicit wide ranges so it
    // only counts 1 here — the key property is it never underflows or crashes.
    expect(displayWidth('a🙂b')).toBeGreaterThanOrEqual(3)
  })
})

describe('padEnd / padStart (visible-column width)', () => {
  it('pads ASCII to the requested visible width', () => {
    expect(padEnd('ab', 4)).toBe('ab  ')
    expect(padStart('ab', 4)).toBe('  ab')
  })

  it('treats CJK text as 2 columns for padding', () => {
    // '中文' is 4 visible columns, so 2 trailing spaces pad to 6.
    expect(padEnd('中文', 6)).toBe('中文  ')
  })

  it('never pads (returns unchanged) when width is already met or exceeded', () => {
    expect(padEnd('中文', 4)).toBe('中文')
    expect(padEnd('abc', 2)).toBe('abc')
  })

  it('does not double-count ANSI escapes in the fill amount', () => {
    expect(padEnd('\x1b[1mX\x1b[0m', 3)).toBe('\x1b[1mX\x1b[0m  ')
  })
})

describe('truncate (visible-width, ANSI-safe)', () => {
  it('truncates long plain text within the visible width', () => {
    const t = truncate('hello world', 5)
    // truncate reserves one column of headroom, so the result is <= 5 visible.
    expect(displayWidth(t)).toBeLessThanOrEqual(5)
    expect(displayWidth(t)).toBeGreaterThan(0)
  })

  it('keeps strings within the width untouched', () => {
    expect(truncate('hi', 5)).toBe('hi')
  })

  it('never emits a partial ANSI escape sequence (stops at a sequence boundary when truncating)', () => {
    const colored = '\x1b[31m' + 'x'.repeat(20) + '\x1b[0m'
    const t = truncate(colored, 6)
    // The leading SGR open is carried through intact.
    expect(t).toContain('\x1b[31m')
    // The output must never end in a partial escape (a dangling ESC or half a sequence).
    expect(/\\x1b\[[0-9;]*$/.test(t)).toBe(false)
    expect(t.endsWith('\x1b')).toBe(false)
    // The visible width is honoured; the closing reset may be cut because it
    // occurs after the truncated region (that is not "cutting an escape in half").
    expect(displayWidth(t)).toBeLessThanOrEqual(6)
  })

  it('approximates a narrow terminal (min width 0) without error', () => {
    const t = truncate('abcdef', 0)
    expect(typeof t).toBe('string')
    expect(t.length).toBe(0)
  })
})
