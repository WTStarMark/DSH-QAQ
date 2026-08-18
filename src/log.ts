/**
 * Structured, multi-file, rotating logger for the guard.
 *
 * Files under ~/.dsh/.qaq/log/:
 *   qaq.log      — everything (info + warn + error), the canonical record
 *   error.log    — warn/error only (so a developer can grep for trouble fast)
 *   access.log   — state transitions: boot verdicts, snapshots, rollbacks,
 *                  reset, status dumps, rollback diffs (crash-audit trail)
 *   host.log     — raw dsh child stdout/stderr, captured while supervised
 *                  (mirrored to the visible window when attached)
 *
 * Lines are one JSON object per record: { ts, level, cat, phase?, msg, ...meta }
 * so developers can machine-parse the log for maintenance/repair triage.
 * All files rotate by size (maxBytes → .1.log, bumping older copies, capacity
 * `keepFiles`). Rotation is best-effort and never throws.
 */
import { appendFileSync, mkdirSync, writeFileSync, renameSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { qaqDir, resolveDshHome } from './paths.ts'

export type LogLevel = 'info' | 'warn' | 'error'

/** Log file kinds. `access` is the crash-audit trail; `host` is the dsh child stream. */
export type LogChannel = 'main' | 'error' | 'access' | 'host'

const ROTATE_BYTES = 256 * 1024 // 256 KB per file before rotating
const KEEP_FILES = 5 // keep up to this many rotated copies

interface LogRecord {
  ts: string
  level: LogLevel
  cat: string
  phase?: string
  msg: string
  [k: string]: unknown
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Rotate a single log file: when it exceeds ROTATE_BYTES, rename to <name>.1.log,
 * bumping older copies. Best effort; never throws.
 */
function rotateFile(file: string, keep: number): void {
  try {
    const st = statSync(file)
    if (st.size < ROTATE_BYTES) return
  } catch { return }
  const base = file.replace(/\.log$/, '')
  for (let i = keep - 1; i >= 1; i--) {
    const src = base + '.' + i + '.log'
    const dst = base + '.' + (i + 1) + '.log'
    try { renameSync(src, dst) } catch { /* not present */ }
  }
  try { renameSync(file, base + '.1.log') } catch { /* ignore */ }
  // Prune beyond the cap.
  try {
    const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
    const dir = idx >= 0 ? file.slice(0, idx + 1) : ''
    const name = file.slice(idx + 1)
    const baseName = name.replace(/\.log$/, '')
    if (dir) {
      for (const n of readdirSync(dir)) {
        const m = n.match(new RegExp('^' + escapeRegExp(baseName) + '\\.(\\d+)\\.log$'))
        if (m && Number(m[1]) > keep) { try { rmSync(join(dir, n), { force: true }) } catch { /* ignore */ } }
      }
    }
  } catch { /* ignore */ }
}

function filePathFor(dir: string, channel: LogChannel): string {
  switch (channel) {
    case 'error': return join(dir, 'error.log')
    case 'access': return join(dir, 'access.log')
    case 'host': return join(dir, 'host.log')
    default: return join(dir, 'qaq.log')
  }
}

/**
 * A logger bound to one home + category. Construct via `new Logger(home)`,
 * or derive category-scoped loggers via `.in(category)`. `info/warn/error`
 * form the backward-compatible surface used across the codebase.
 */
export class Logger {
  private dir: string | null = null
  private home: string
  constructor(home: string, private tag = 'qaq', private cat = 'qaq', private phase?: string) {
    // An empty/whitespace home would resolve .qaq relative to the cwd and
    // pollute the caller's directory with log files; fall back to the real DSH
    // home so logs always land under a home's .qaq/log.
    this.home = home && home.trim().length > 0 ? home : resolveDshHome()
    try {
      const dir = join(qaqDir(this.home), 'log')
      mkdirSync(dir, { recursive: true })
      this.dir = dir
    } catch { this.dir = null }
  }

  /** A child logger sharing the same home but with a distinct category. */
  in(category: string): Logger {
    return new Logger(this.home || '', this.tag, category, this.phase)
  }

  /** Re-bind this logger to a named phase (boot / confirm / rollback / restart). */
  at(phase: string): Logger {
    return new Logger(this.home || '', this.tag, this.cat, phase)
  }

  info(msg: string, meta: Record<string, unknown> = {}): void { this.write('info', msg, meta) }
  warn(msg: string, meta: Record<string, unknown> = {}): void { this.write('warn', msg, meta) }
  error(msg: string, meta: Record<string, unknown> = {}): void { this.write('error', msg, meta) }

  /** A structured access (crash-audit) record; mirrored to stdout for visibility. */
  access(msg: string, meta: Record<string, unknown> = {}): void {
    this.write('info', msg, meta, 'access')
    process.stdout.write('[qaq][access] ' + msg + '\n')
  }

  /** Capture a raw chunk of the supervised child's output to host.log. */
  host(chunk: string, stream: 'stdout' | 'stderr' = 'stderr'): void {
    this.writeRaw(stream === 'stderr' ? 'error' : 'info', String(chunk), 'host')
  }

  private ts(): string { return new Date().toISOString() }
  private logFilePath(channel: LogChannel): string | null {
    if (!this.dir) return null
    return filePathFor(this.dir, channel)
  }

  private write(level: LogLevel, msg: string, meta: Record<string, unknown>, extraChannel?: LogChannel): void {
    if (level === 'error') process.stderr.write('[qaq][error] ' + msg + '\n')
    else if (level === 'warn') process.stderr.write('[qaq][warn] ' + msg + '\n')
    else process.stderr.write('[qaq] ' + msg + '\n')

    const rec: LogRecord = { ts: this.ts(), level, cat: this.cat, msg }
    if (this.phase) rec.phase = this.phase
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) rec[k] = v
    const line = JSON.stringify(rec) + '\n'

    const main = this.logFilePath('main')
    if (main) this.rawAppend(main, line)
    if (level === 'warn' || level === 'error') {
      const ef = this.logFilePath('error')
      if (ef) this.rawAppend(ef, line)
    }
    if (extraChannel === 'access') {
      const af = this.logFilePath('access')
      if (af) this.rawAppend(af, line)
    }
  }

  private writeRaw(level: LogLevel, text: string, channel: LogChannel): void {
    const hf = this.logFilePath('host')
    if (!hf) return
    const ts = this.ts()
    const prefixed = String(text).split('\n').filter(Boolean).map(l => level + ' ' + ts + ' ' + l).join('\n') + '\n'
    this.rawAppend(hf, prefixed)
    if (level === 'error') process.stderr.write(text)
    else process.stdout.write(text)
  }

  private sizes = new Map<string, number>()
  private lastCheck = new Map<string, number>()
  private rawAppend(file: string, text: string): void {
    try {
      const bytes = Buffer.byteLength(text, 'utf8')
      const prev = this.sizes.get(file) ?? 0
      this.sizes.set(file, prev + bytes)
      // Only stat once per ~64KB of growth; rotation stays accurate enough.
      const since = (this.lastCheck.get(file) ?? 0) + bytes
      if (since >= 64 * 1024) {
        this.lastCheck.set(file, 0)
        rotateFile(file, KEEP_FILES)
      } else {
        this.lastCheck.set(file, since)
      }
      appendFileSync(file, text, 'utf8')
    } catch { /* ignore */ }
  }
}

/** Convenience: write a one-off access record to access.log for a home. */
export function accessDump(home: string, cat: string, msg: string, meta: Record<string, unknown> = {}): void {
  new Logger(home, 'qaq', cat).access(msg, meta)
}
