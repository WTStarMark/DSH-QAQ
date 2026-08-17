import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

describe('installPlugin edge cases', () => {
  it('warns about a stale manual insert row but still mounts cleanly', () => {
    const pr = profileDir(home, 'stale');
    mkdirSync(pr, { recursive: true });
    writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }));
    // A leftover user-layer row referencing the plugin = duplicate entry id hazard.
    writeFileSync(join(pr, 'cordis.patch.yml'), '- insert:\n    - id: dsh-qaq\n      name: x\n');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const r = installPlugin(home, 'stale', new Logger(home));
    expect(r.ok).toBe(true);
    // The warning about the stale row must have been emitted.
    expect(warn.mock.calls.some(([m]) => String(m).includes('stale'))).toBe(true);
    warn.mockRestore();
  });

  it('unmounts cleanly (does not write the manifest) when the node_modules link cannot be created', () => {
    const pr = profileDir(home, 'nolink');
    mkdirSync(pr, { recursive: true });
    const before = JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } });
    writeFileSync(join(pr, 'package.json'), before);
    writeFileSync(join(pr, 'cordis.patch.yml'), '[]\n');
    // Occupy the module path with a plain FILE so the junction cannot be made.
    mkdirSync(join(pr, 'node_modules'), { recursive: true });
    writeFileSync(join(pr, 'node_modules', 'dsh-qaq'), '');
    const r = installPlugin(home, 'nolink', new Logger(home));
    expect(r.ok).toBe(false);
    expect(r.mounted).toBe(false);
    // The profile manifest must be left byte-identical (the failed link undoes it).
    expect(readFileSync(join(pr, 'package.json'), 'utf8')).toBe(before);
  });

  it('reports a profile whose package.json is not valid JSON without crashing', () => {
    const pr = profileDir(home, 'badjson');
    mkdirSync(pr, { recursive: true });
    writeFileSync(join(pr, 'package.json'), '{not json');
    const r = installPlugin(home, 'badjson', new Logger(home));
    expect(r.ok).toBe(false);
  });
});

describe('installPlugin junction overwrite (update path)', () => {
  /** A profile with a bundle list ready for dsh-qaq but no link yet. */
  function readyProfile(name: string): string {
    const pr = profileDir(home, name)
    mkdirSync(pr, { recursive: true })
    writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }))
    writeFileSync(join(pr, 'cordis.patch.yml'), '[]\n')
    return pr
  }

  it('replaces a junction pointing at a STALE QAQ copy (the re-mount update path)', () => {
    const pr = readyProfile('stale-link')
    const stale = mkdtempSync(join(tmpdir(), 'qaq-stale-'))
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ name: 'dsh-qaq', version: '0.0.0-old' }))
    const link = join(pr, 'node_modules', 'dsh-qaq')
    mkdirSync(join(pr, 'node_modules'), { recursive: true })
    symlinkSync(stale, link, 'junction')

    const r = installPlugin(home, 'stale-link', new Logger(home))
    expect(r.ok).toBe(true)
    // The junction now points at THIS repo's package, not the stale copy.
    expect(resolve(readlinkSync(link))).toBe(findQaqPluginDir())
    // And the module resolves to the real plugin.
    const pkg = JSON.parse(readFileSync(join(link, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('dsh-qaq')
    rmSync(stale, { recursive: true, force: true })
  })

  it('repairs an orphaned junction whose target directory vanished', () => {
    const pr = readyProfile('orphan')
    const gone = mkdtempSync(join(tmpdir(), 'qaq-gone-'))
    const link = join(pr, 'node_modules', 'dsh-qaq')
    mkdirSync(join(pr, 'node_modules'), { recursive: true })
    symlinkSync(gone, link, 'junction')
    rmSync(gone, { recursive: true, force: true }) // target gone → orphan link

    expect(existsSync(join(link, 'package.json'))).toBe(false)
    const r = installPlugin(home, 'orphan', new Logger(home))
    expect(r.ok).toBe(true)
    expect(existsSync(join(link, 'package.json'))).toBe(true)
  })

  it('never touches a REAL directory at the module path (user data protection)', () => {
    const pr = readyProfile('real-dir')
    const link = join(pr, 'node_modules', 'dsh-qaq')
    mkdirSync(join(pr, 'node_modules', 'dsh-qaq'), { recursive: true })
    writeFileSync(join(link, 'package.json'), JSON.stringify({ name: 'user-stuff' }))
    writeFileSync(join(link, 'keep.txt'), 'do not delete')

    const r = installPlugin(home, 'real-dir', new Logger(home))
    expect(r.ok).toBe(false) // the link cannot be replaced → mount fails cleanly
    // The user's directory is intact.
    expect(readFileSync(join(link, 'keep.txt'), 'utf8')).toBe('do not delete')
    expect(JSON.parse(readFileSync(join(link, 'package.json'), 'utf8')).name).toBe('user-stuff')
  })

  it('leaves a correct junction alone (idempotent re-mount)', () => {
    const pr = readyProfile('ok-link')
    const r1 = installPlugin(home, 'ok-link', new Logger(home))
    expect(r1.ok).toBe(true)
    const link = join(pr, 'node_modules', 'dsh-qaq')
    const targetBefore = readlinkSync(link)
    const r2 = installPlugin(home, 'ok-link', new Logger(home))
    expect(r2.ok).toBe(true)
    expect(readlinkSync(link)).toBe(targetBefore)
  })
});
