/**
 * ANSI color helpers for the QAQ TUI — blue-gradient ASCII banner and colorized
 * separators. Colors degrade gracefully when the terminal reports <8-bit color.
 *
 * The QAQ banner is a block letter-art whose glyphs are painted per-column with
 * a horizontal blue gradient: the leftmost column uses `from`, the rightmost
 * uses `to`, and intermediate columns interpolate in RGB — a smooth left→right
 * blue sweep across the "QAQ" wordmark.
 */
import type { WriteStream } from 'node:tty'

export type RGB = [number, number, number]

export function lerp(a: RGB, b: RGB, t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * c),
    Math.round(a[1] + (b[1] - a[1]) * c),
    Math.round(a[2] + (b[2] - a[2]) * c),
  ]
}

export function fgTruecolor(c: RGB): string { return '\x1b[38;2;' + c[0] + ';' + c[1] + ';' + c[2] + 'm' }

/** True when the terminal exposes at least 8-bit (256) color. */
export function hasColor(out: WriteStream): boolean {
  return typeof out.getColorDepth === 'function' && out.getColorDepth() >= 8
}

const RESET = '\x1b[0m'

/**
 * Colorize each line of an ASCII banner with a per-column foreground gradient
 * sweeping from `from` (left) to `to` (right). Space/gap glyphs stay plain so
 * the gradient reads as the block strokes. Returns one colorized line per input.
 */
export function bannerGradient(lines: string[], from: RGB, to: RGB, bold = true): string[] {
  const b = bold ? '\x1b[1m' : ''
  return lines.map((line) => {
    const width = line.length
    let out = ''
    for (let i = 0; i < width; i++) {
      const t = width <= 1 ? 0 : i / (width - 1)
      const ch = line[i]
      if (ch === ' ' || ch === '\t') {
        out += ch
      } else {
        out += b + fgTruecolor(lerp(from, to, t)) + ch + RESET
      }
    }
    return out
  })
}
