import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight, resolveCommand, findCheckoutCli, isPortFree, resolveDshHome } from '../src/env.ts'
import { qaqDir, profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'
import { installPlugin } from '../src/install-plugin.ts'

let home = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-env-')) })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('env.findCheckoutCli / resolveCommand', () => {
  it('finds a DSH checkout CLI entry by path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-'));
    mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true });
    writeFileSync(join(root, 'apps', 'cli', 'src', 'bin.ts'), '');
    expect(findCheckoutCli(root)).toBe(join(root, 'apps', 'cli', 'src', 'bin.ts'));
    rmSync(root, { recursive: true, force: true });
  });
  it('uses QAQ_DSH_CMD when set', () => {
    const prev = process.env.QAQ_DSH_CMD;
    process.env.QAQ_DSH_CMD = 'node --import tsx/esm apps/cli/src/bin.ts web';
    try {
      const r = resolveCommand(undefined);
      expect(r.source).toBe('QAQ_DSH_CMD');
      expect(r.command.join(' ')).toContain('apps/cli/src/bin.ts');
    } finally {
      if (prev === undefined) delete process.env.QAQ_DSH_CMD; else process.env.QAQ_DSH_CMD = prev;
    }
  });

  it('finds a checkout CLI when --cwd points to a DSH checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-co-'));
    mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true });
    writeFileSync(join(root, 'apps', 'cli', 'src', 'bin.ts'), '');
    const prev = process.env.QAQ_DSH_CMD;
    delete process.env.QAQ_DSH_CMD;
    const r = resolveCommand(root);
    expect(r.source).toBe('checkout');
    expect(r.cwd).toBe(root);
    rmSync(root, { recursive: true, force: true });
    if (prev !== undefined) process.env.QAQ_DSH_CMD = prev;
  });
});

describe('env resolveDshHome', () => {
  it('honors DSH_HOME env', () => {
    expect(resolveDshHome({ DSH_HOME: home })).toBe(home);
  });
});

describe('env.isPortFree', () => {
  it('reports a listening port as busy and a dead port as free', async () => {
    const busy = require('node:net').createServer();
    await new Promise((res) => busy.listen(0, '127.0.0.1', res));
    const port = (busy.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise((res) => busy.close(res));
    expect(await isPortFree(port)).toBe(true);
  });
});