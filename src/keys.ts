/**
 * Incremental keyboard parser for raw-mode TUI input.
 *
 * Raw-mode stdin delivers one character (or a chunk) at a time. Arrow keys and
 * other special keys arrive as multi-byte escape sequences (e.g. \x1b[A up,
 * \x1b[B down, \x1bOA / \x1bOB on some Windows terminals). The parser is
 * stateful so partial sequences can arrive across multiple 'data' events without
 * being lost or mis-parsed as printable characters — that was the "arrow keys do
 * nothing" bug: the leading \x1b was consumed without being carried into the
 * buffer, so the sequence never matched. It also never treats the '[ ' or 'O' of
 * a CSI/SS3 prefix as a final byte, so split delivery works.
 */
export type Key = 'up' | 'down' | 'left' | 'right' | 'enter' | 'space' | 'esc' | 'ctrl-c' | 'char' | 'none'

/** Known complete arrow-key sequences → direction. */
const ARROWS: Record<string, Key> = {
  '\x1b[A': 'up', '\x1bOA': 'up',
  '\x1b[B': 'down', '\x1bOB': 'down',
  '\x1b[C': 'right', '\x1bOC': 'right',
  '\x1b[D': 'left', '\x1bOD': 'left',
}

/** Is `seq` a prefix of any known arrow sequence (so we keep buffering)? */
function isArrowPrefix(seq: string): boolean {
  return Object.keys(ARROWS).some((a) => a.startsWith(seq))
}

export class KeyParser {
  private esc: string | null = null

  /** Feeds one character; returns the recognized action (may be 'none'). */
  feed(ch: string): Key {
    if (this.esc !== null) {
      this.esc += ch
      const seq = this.esc
      const hit = ARROWS[seq]
      if (hit) { this.esc = null; return hit }
      // A lone ESC alone (requesting to stop) or a completed unknown sequence.
      if (seq === '\x1b') { this.esc = null; return 'none' }
      if (!isArrowPrefix(seq)) {
        this.esc = null
        return 'none'
      }
      return 'none'
    }
    if (ch === '\x1b') { this.esc = '\x1b'; return 'none' }
    if (ch === '\n' || ch === '\r') return 'enter'
    if (ch === ' ') return 'space'
    if (ch === '\x03') return 'ctrl-c'
    if (ch === '\x7f') return 'none'
    return 'char'
  }

  /** True while a partial escape sequence is buffered. */
  get inEscape(): boolean { return this.esc !== null }
}
