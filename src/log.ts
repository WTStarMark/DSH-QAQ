/**
 * Logging for the guard. Writes to ~/.dsh/.qaq/log/qaq.log and mirrors to
 * process stderr.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { qaqDir } from './paths.ts'

export class Logger {
  private file: string | null = null
  constructor(home: string, private tag = 'qaq') {
    try {
      const dir = join(qaqDir(home), 'log')
      mkdirSync(dir, { recursive: true })
      this.file = join(dir, 'qaq.log')
    } catch { this.file = null }
  }
  private ts(): string { return new Date().toISOString() }
  info(msg: string): void { this.write('info', msg); process.stderr.write('[qaq] ' + msg + '\n') }
  warn(msg: string): void { this.write('warn', msg); process.stderr.write('[qaq][warn] ' + msg + '\n') }
  error(msg: string): void { this.write('error', msg); process.stderr.write('[qaq][error] ' + msg + '\n') }
  private write(level: string, msg: string): void {
    if (this.file) { try { appendFileSync(this.file, this.ts() + ' [' + level + '] ' + msg + '\n') } catch { /* ignore */ } }
  }
}
