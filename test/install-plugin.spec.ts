import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPlugin, findQaqPluginDir } from '../src/install-plugin.ts'
import { profileDir, qaqDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'

let home = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-ip-')); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); vi.spyOn(process.stdout, 'write').mockImplementation(() => true) })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('installPlugin', () => {
  it('is a no-op for an uninitialized profile (fails gracefully)', () => {
    const r = installPlugin(home, 'missing', new Logger(home));
    expect(r.ok).toBe(false);
    expect(r.mounted).toBe(false);
  });

  it('mounts dsh-qaq into a real profile as a bundle layer and is idempotent', () => {
    const pr = profileDir(home, 'web');
    mkdirSync(pr, { recursive: true });
    writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a'] } } }));
    writeFileSync(join(pr, 'cordis.patch.yml'), '[]\n');
    const r = installPlugin(home, 'web', new Logger(home));
    expect(r.ok).toBe(true);
    expect(r.mounted).toBe(true);
    // bundle list now includes dsh-qaq
    const pkg = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8'));
    expect(pkg.dsh.profile.bundles).toContain('dsh-qaq');
    // node_modules link created
    expect(existsSync(join(pr, 'node_modules', 'dsh-qaq', 'package.json'))).toBe(true);
    // The user patch layer is NEVER touched: DSH auto-loads the plugin via the
    // bundle's own dsh.bundle.patch; a manual insert row would duplicate the
    // entry id and crash the boot.
    expect(readFileSync(join(pr, 'cordis.patch.yml'), 'utf8')).toBe('[]\n');
    // idempotent: second call still ok and does not duplicate the bundle
    const r2 = installPlugin(home, 'web', new Logger(home));
    expect(r2.ok).toBe(true);
    const pkg2 = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8'));
    expect(pkg2.dsh.profile.bundles.filter((b: string) => b === 'dsh-qaq')).toHaveLength(1);
  });

  it('findQaqPluginDir resolves within this repo', () => {
    const d = findQaqPluginDir();
    expect(existsSync(join(d, 'package.json'))).toBe(true);
  });
});
