import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../src/log.ts'
import { qaqDir } from '../src/paths.ts'

let home = ''
let logDir = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-log-')); const q = qaqDir(home); mkdirSync(join(q, 'log'), { recursive: true }); logDir = join(q, 'log') })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

// Silence console noise from Logger (it mirrors to stderr).
beforeAll(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); vi.spyOn(process.stdout, 'write').mockImplementation(() => true) })

describe('Logger structured + separate files', () => {
  it('writes structured JSON lines to qaq.log', () => {
    const log = new Logger(home);
    log.at('boot').info('host ready');
    const text = readFileSync(join(logDir, 'qaq.log'), 'utf8');
    const line = text.trim().split('\n').at(-1);
    const rec = JSON.parse(line as string);
    expect(rec.level).toBe('info');
    expect(rec.cat).toBe('qaq');
    expect(rec.phase).toBe('boot');
    expect(rec.msg).toBe('host ready');
    expect(typeof rec.ts).toBe('string');
  });

  it('writes warn/error to error.log too', () => {
    const log = new Logger(home);
    log.error('boom');
    const err = readFileSync(join(logDir, 'error.log'), 'utf8');
    const rec = JSON.parse(err.trim().split('\n').at(-1) as string);
    expect(rec.level).toBe('error');
  });

  it('writes access records to access.log', () => {
    const log = new Logger(home);
    log.access('rolled back to last-good', { profile: 'web' });
    expect(existsSync(join(logDir, 'access.log'))).toBe(true);
    const acc = readFileSync(join(logDir, 'access.log'), 'utf8');
    expect(acc).toContain('rolled back to last-good');
    expect(acc).toContain('profile');
  });

  it('category-scoped logger via .in() writes distinct cat', () => {
    const log = new Logger(home);
    log.in('rollback').info('diff applied');
    const text = readFileSync(join(logDir, 'qaq.log'), 'utf8');
    const rec = JSON.parse(text.trim().split('\n').at(-1) as string);
    expect(rec.cat).toBe('rollback');
  });

  it('rotates a large file to .1.log', () => {
    const log = new Logger(home);
    // ~3500 lines of ~90 chars ≈ 315KB > 256KB rotation threshold.
    for (let i = 0; i < 3500; i++) log.info('y'.repeat(80) + ' line' + i);
    const names = readdirSync(logDir);
    expect(names.some(n => /qaq\.1\.log/.test(n))).toBe(true);
  }, 30000);
});
