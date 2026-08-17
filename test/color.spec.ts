import { describe, it, expect } from 'vitest'
import { lerp, fgTruecolor, bannerGradient, hasColor, type RGB } from '../src/color.ts'

describe('lerp', () => {
  it('returns the from colour at t=0 and the to colour at t=1', () => {
    const a: RGB = [10, 20, 30]
    const b: RGB = [40, 50, 60]
    expect(lerp(a, b, 0)).toEqual(a)
    expect(lerp(a, b, 1)).toEqual(b)
  })

  it('interpolates midpoints and rounds', () => {
    expect(lerp([0, 0, 0], [100, 100, 100], 0.5)).toEqual([50, 50, 50])
    // 99 * 1/3 = 33 → rounds to 33 regardless of the direction.
    expect(lerp([0, 0, 0], [99, 99, 99], 1 / 3)).toEqual([33, 33, 33])
  })

  it('clamps t outside [0,1]', () => {
    expect(lerp([0, 0, 0], [10, 10, 10], -1)).toEqual([0, 0, 0])
    expect(lerp([0, 0, 0], [10, 10, 10], 2)).toEqual([10, 10, 10])
  })
})

describe('fgTruecolor', () => {
  it('emits an SGR 38;2;r;g;b sequence', () => {
    expect(fgTruecolor([1, 2, 3])).toBe('\x1b[38;2;1;2;3m')
  })
})

describe('bannerGradient', () => {
  const A: RGB = [10, 20, 30]
  const B: RGB = [200, 100, 50]

  it('paints each non-space glyph with a truecolor SGR and resets it', () => {
    const out = bannerGradient(['A B'], A, B)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('\x1b[38;2;')
    expect(out[0]).toContain('A')
    expect(out[0]).toContain('B')
  })

  it('keeps spaces uncoloured (SGR spans a bare space instead of wrapping it)', () => {
    const out = bannerGradient(['X Y'], [10, 0, 0], [0, 20, 0])
    // The space must sit as a bare byte between the previous glyph's reset and the
    // next glyph's opening SGR — never wrapped as \x1b[..m'space'\x1b[0m.
    expect(out[0]).toContain('\x1b[0m ' + '\x1b[1m')
    // The glyphs themselves are colourised with the interpolated gradients.
    expect(out[0]).toContain('\x1b[38;2;10;0;0mX')
    expect(out[0]).toContain('\x1b[38;2;0;20;0mY')
  })

  it('produces one output line per input line', () => {
    expect(bannerGradient(['ab', 'cd'], A, B)).toHaveLength(2)
    expect(bannerGradient(['only'], A, B)).toHaveLength(1)
  })

  it('handles a single-character line without dividing by zero', () => {
    const out = bannerGradient(['X'], A, B)
    expect(out[0]).toContain('\x1b[38;2;')
  })
})

describe('hasColor', () => {
  it('false when getColorDepth is absent or below 8', () => {
    // A bare object without getColorDepth → false.
    expect(hasColor({} as any)).toBe(false)
    expect(hasColor({ getColorDepth: () => 4 } as any)).toBe(false)
  })

  it('true when getColorDepth reports at least 8-bit (256)', () => {
    expect(hasColor({ getColorDepth: () => 8 } as any)).toBe(true)
    expect(hasColor({ getColorDepth: () => 24 } as any)).toBe(true)
  })
})
