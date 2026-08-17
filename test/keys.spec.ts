import { describe, it, expect } from 'vitest'
import { KeyParser, type Key } from '../src/keys.ts'

/** Feed a whole key string through the parser, collecting recognized keys. */
function parseAll(inputs: string[]): Key[] {
  const p = new KeyParser()
  const out: Key[] = []
  for (const input of inputs) {
    for (const ch of input) {
      const k = p.feed(ch)
      if (k !== 'none') out.push(k)
    }
  }
  return out
}

describe('KeyParser (raw-mode input)', () => {
  it('recognizes up/down arrow keys even when bytes arrive split across events', () => {
    // Real terminals may deliver \x1b, then [A, in separate 'data' events.
    expect(parseAll(['\x1b', '[A'])).toEqual(['up'])
    expect(parseAll(['\x1b[B'])).toEqual(['down'])
  })

  it('recognizes the SS3 arrow form (\x1bOA / \x1bOB) used by some Windows terminals', () => {
    expect(parseAll(['\x1bOA'])).toEqual(['up'])
    expect(parseAll(['\x1bOB'])).toEqual(['down'])
  })

  it('maps enter/space/ctrl-c correctly', () => {
    expect(parseAll(['\n'])).toEqual(['enter'])
    expect(parseAll([' '])).toEqual(['space'])
    expect(parseAll(['\x03'])).toEqual(['ctrl-c'])
  })

  it('returns char for printable letters (q, j, k, digits)', () => {
    const p = new KeyParser()
    expect(p.feed('q')).toBe('char')
    expect(p.feed('j')).toBe('char')
    const np = new KeyParser()
    expect(np.feed('5')).toBe('char')
  })

  it('recognizes all four arrows across split delivery and never leaks a stray prefix', () => {
    const right = new KeyParser()
    expect(right.feed('\x1b')).toBe('none')
    expect(right.feed('[')).toBe('none')
    expect(right.feed('C')).toBe('right')
    // A fresh parser continues to parse independently (no stale esc state leaks).
    const next = new KeyParser()
    next.feed('a') // printable char first, then an arrow
    expect(next.feed('\x1b')).toBe('none')
    expect(next.feed('[')).toBe('none')
    expect(next.feed('D')).toBe('left')
  })
})
