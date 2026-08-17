/**
 * Terminal display-width helpers — the foundation for correct CJK + ANSI layout.
 *
 * Terminal columns are NOT `string.length`: fullwidth (CJK / wide) glyphs occupy
 * 2 columns, and ANSI SGR escape sequences (\x1b[..m) take 0 columns. These
 * helpers are width-aware AND ANSI-aware, so a rule / pad / truncate applied to
 * a colorized string still lands exactly within the column budget — that is what
 * prevents a `══` bar or a Chinese caption from overflowing a TUI row.
 */

// Matches ANSI SGR (color/style) and cursor escapes so they count as zero width.
// Full CSI: \x1b[ params(0-9;:) intermediates? final(@-~). SGR uses \x1b[..m.
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g

/** Width of a string's visible (non-escape) characters, CJK-wide = 2. */
/** CSI final byte range is 0x40–0x7E (e.g. 'm' for SGR, 'H' for CUP, 'J' for ED). */
function isFinalByte(code: number): boolean { return code >= 0x40 && code <= 0x7e }

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s.replace(ANSI_RE, '')) {
    const c = ch.codePointAt(0)!
    // em dash renders fullwidth in CJK console fonts
    const wide = c === 0x2014
      || (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x33ff)
      || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

/** Right-fill a string (with spaces) to `width` visible columns. */
export function padEnd(s: string, width: number): string {
  const n = Math.max(0, width - displayWidth(s))
  return s + ' '.repeat(n)
}

/** Left-fill a string to `width` visible columns. */
export function padStart(s: string, width: number): string {
  const n = Math.max(0, width - displayWidth(s))
  return ' '.repeat(n) + s
}

/**
 * Truncate a string so its VISIBLE width is `width` columns or fewer, while
 * preserving complete ANSI escape sequences (so color codes are never cut in
 * half). Never overflows even with CJK + color.
 */
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s
  let out = ''
  let w = 0
  let i = 0
  const text = s
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\x1b' && i + 1 < text.length && text[i + 1] === '[') {
      // Carry the whole CSI sequence through untouched (zero width) — find its
      // terminating byte in @-~ (SGR ends with 'm').
      let j = i + 2
      while (j < text.length && !isFinalByte(text.charCodeAt(j))) j++
      const end = j < text.length ? j + 1 : i + 2
      out += text.slice(i, end)
      i = end
      continue
    }
    const cw = displayWidth(ch) // 1 char; a lone surrogate is handled as width 1
    if (w + cw > Math.max(0, width - 1)) break
    out += ch; w += cw; i++
  }
  return out
}
