import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPlugins, setPluginEnabled, installPluginModule, uninstallPlugin, discoverPluginSources, pluginRowText } from '../src/plugin-manager.ts'
import { profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'
import { makeT } from '../src/i18n.ts'
import { findDshPackages } from '../src/dsh-context.ts'

let home = ''
let log: Logger
let checkout: string

/** Build a DSH profile dir (the real profile home pattern). */
function makeProfile(name = 'web', bundles: string[] = []): string {
  const pr = profileDir(home, name)
  mkdirSync(join(pr, 'node_modules'), { recursive: true })
  writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, dsh: { profile: { bundles } } }))
  return pr
}

/** Write a minimal DSH plugin/bundle package (package.json + cordis.patch.yml). */
function writeDshPlugin(dir: string, pkgName: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: pkgName, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ' + pkgName + '\n      name: ' + pkgName + '\n')
  return dir
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-pluginmgr-'))
  log = new Logger(home, 'qaq', 'test')
  // A fake DSH checkout with real-style packages/ dir.
  checkout = join(home, 'fake-dsh')
  writeDshPlugin(join(checkout, 'packages', 'bundle', 'base'), '@deepseek-ai/dsh-base')
  writeDshPlugin(join(checkout, 'packages', 'bundle', 'web-app'), '@deepseek-ai/dsh-web-app')
  writeDshPlugin(join(checkout, 'packages', 'bundle', 'headless'), '@deepseek-ai/dsh-headless')
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('findDshPackages (real checkout scan)', () => {
  it('discovers the DSH bundle packages under packages/', () => {
    const dirs = findDshPackages(checkout)
    expect(dirs.length).toBeGreaterThanOrEqual(3)
  })

  it('returns [] for a non-checkout root', () => {
    expect(findDshPackages(join(home, 'nowhere'))).toEqual([])
  })
})

describe('listPlugins (real DSH profile)', () => {
  it('enriches installed/bundled plugins with an install source from the checkout', () => {
    const pr = makeProfile('web', ['@deepseek-ai/dsh-base'])
    // Install base into the profile node_modules.
    installPluginModule({ profileDir: pr, profile: 'web', name: '@deepseek-ai/dsh-base', source: join(checkout, 'packages', 'bundle', 'base') }, log)
    const infos = listPlugins({ profileDir: pr, profile: 'web', checkout })
    const base = infos.find((p) => p.name === '@deepseek-ai/dsh-base')!
    expect(base.installed).toBe(true)
    expect(base.enabled).toBe(true)
    // The real DSH source is exposed so the manager knows where it came from.
    expect(base.source).toBe(join(checkout, 'packages', 'bundle', 'base'))
    // An installable-but-not-installed sibling is surfaced too.
    const webApp = infos.find((p) => p.name === '@deepseek-ai/dsh-web-app')!
    expect(webApp.installed).toBe(false)
    expect(webApp.enabled).toBe(false)
    expect(webApp.source).toBe(join(checkout, 'packages', 'bundle', 'web-app'))
  })

  it('reports a bundled-but-missing module as an orphan', () => {
    const pr = makeProfile('orphan', ['@deepseek-ai/dsh-ghost'])
    const infos = listPlugins({ profileDir: pr, profile: 'orphan', checkout })
    const g = infos.find((p) => p.name === '@deepseek-ai/dsh-ghost')!
    expect(g.installed).toBe(false)
    expect(g.enabled).toBe(true)
  })

  it('treats a cordis.patch.yml INSERT as enabled (the dsh-precise-cache shape)', () => {
    // A plugin enabled via the patch layer, NOT via dsh.profile.bundles.
    const pr = makeProfile('patch', [])
    writeFileSync(join(pr, 'cordis.patch.yml'), '- insert:\n    - id: precise-cache\n      name: dsh-precise-cache\n')
    // It is installed in the pool.
    writeDshPlugin(join(home, 'profiles', 'node_modules', 'dsh-precise-cache'), 'dsh-precise-cache')
    const infos = listPlugins({ profileDir: pr, profile: 'patch', poolDir: join(home, 'profiles', 'node_modules') })
    const c = infos.find((p) => p.name === 'dsh-precise-cache')!
    expect(c.installed).toBe(true)
    expect(c.enabled).toBe(true) // enabled via patch insert, not bundles
  })

  it('enumerates the shared module pool (launcher-installed real DSH plugins)', () => {
    const pr = makeProfile('poolprof', [])
    // The shared pool holds many DSH plugins (like the real ~150+ @deepseek-ai/dsh-*).
    const pool = join(home, 'profiles', 'node_modules')
    writeDshPlugin(join(pool, '@deepseek-ai', 'dsh-tool-fs'), '@deepseek-ai/dsh-tool-fs')
    writeDshPlugin(join(pool, '@deepseek-ai', 'dsh-session'), '@deepseek-ai/dsh-session')
    writeDshPlugin(join(pool, '@earendil-works', 'some-plugin'), '@earendil-works/some-plugin')

    const infos = listPlugins({ profileDir: pr, profile: 'poolprof', checkout, poolDir: pool })
    expect(infos.find((p) => p.name === '@deepseek-ai/dsh-tool-fs')?.installed).toBe(true)
    expect(infos.find((p) => p.name === '@deepseek-ai/dsh-session')?.installed).toBe(true)
    expect(infos.find((p) => p.name === '@earendil-works/some-plugin')?.installed).toBe(true)
    // None are enabled (not in the profile's bundle list).
    expect(infos.find((p) => p.name === '@deepseek-ai/dsh-tool-fs')?.enabled).toBe(false)
  })

  it('overlays the LIVE inventory enabled/phase onto the full plugin set (disabled plugins stay visible)', () => {
    const pr = makeProfile('live')
    // A pool module + a checkout bundle source are present.
    writeDshPlugin(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tool-fs'), '@deepseek-ai/dsh-tool-fs')
    writeDshPlugin(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-session'), '@deepseek-ai/dsh-session')
    const liveEntries = [
      { entryId: 'dsh-tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberPhase: 'active' },
      { entryId: 'dsh-session', moduleName: '@deepseek-ai/dsh-session', enabled: false, fiberPhase: 'failed' },
    ]
    const infos = listPlugins({ profileDir: pr, profile: 'live', poolDir: join(home, 'profiles', 'node_modules'), liveEntries })
    // The live loader's enabled flag is authoritative for both live entries.
    expect(infos.find((p) => p.name === '@deepseek-ai/dsh-tool-fs')?.enabled).toBe(true)
    expect(infos.find((p) => p.name === '@deepseek-ai/dsh-session')?.enabled).toBe(false)
  })
})

describe('installPluginModule (into the real DSH profile)', () => {
  it('install+enable a DSH bundle from its checkout package, all-or-nothing', () => {
    const pr = makeProfile('inst')
    const src = join(checkout, 'packages', 'bundle', 'headless')
    const r = installPluginModule({ profileDir: pr, profile: 'inst', name: '@deepseek-ai/dsh-headless', source: src }, log)
    expect(r.ok).toBe(true)

    const infos = listPlugins({ profileDir: pr, profile: 'inst', checkout })
    const h = infos.find((p) => p.name === '@deepseek-ai/dsh-headless')!
    expect(h.installed).toBe(true)
    expect(h.enabled).toBe(true)
    if (h.linkTarget) { // junction target points at the real DSH package
      expect(h.linkTarget.replace(/\\$/, '')).toContain('headless')
    }
  })

  it('rejects a non-plugin source without mutating the profile', () => {
    const pr = makeProfile('badsrc')
    const before = readFileSync(join(pr, 'package.json'), 'utf8')
    const r = installPluginModule({ profileDir: pr, profile: 'badsrc', name: 'x', source: join(home, 'not-a-plugin') }, log)
    expect(r.ok).toBe(false)
    expect(readFileSync(join(pr, 'package.json'), 'utf8')).toBe(before)
  })

  it('is idempotent', () => {
    const pr = makeProfile('idem', ['@deepseek-ai/dsh-base'])
    const src = join(checkout, 'packages', 'bundle', 'base')
    const r1 = installPluginModule({ profileDir: pr, profile: 'idem', name: '@deepseek-ai/dsh-base', source: src }, log)
    const r2 = installPluginModule({ profileDir: pr, profile: 'idem', name: '@deepseek-ai/dsh-base', source: src }, log)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(listPlugins({ profileDir: pr, profile: 'idem', checkout }).filter((p) => p.name === '@deepseek-ai/dsh-base')).toHaveLength(1)
  })
})

describe('setPluginEnabled (enable/disable in the DSH profile)', () => {
  it('disables an installed plugin but keeps its module', () => {
    const pr = makeProfile('dis')
    const src = join(checkout, 'packages', 'bundle', 'web-app')
    installPluginModule({ profileDir: pr, profile: 'dis', name: '@deepseek-ai/dsh-web-app', source: src }, log)
    const r = setPluginEnabled({ profileDir: pr, profile: 'dis', name: '@deepseek-ai/dsh-web-app', enabled: false, checkout }, log)
    expect(r.ok).toBe(true)
    const infos = listPlugins({ profileDir: pr, profile: 'dis', checkout })
    const w = infos.find((p) => p.name === '@deepseek-ai/dsh-web-app')!
    expect(w.enabled).toBe(false)
    expect(w.installed).toBe(true) // module retained
  })

  it('re-enables a disabled plugin', () => {
    const pr = makeProfile('re', ['@deepseek-ai/dsh-base'])
    const src = join(checkout, 'packages', 'bundle', 'base')
    installPluginModule({ profileDir: pr, profile: 're', name: '@deepseek-ai/dsh-base', source: src }, log)
    setPluginEnabled({ profileDir: pr, profile: 're', name: '@deepseek-ai/dsh-base', enabled: false, checkout }, log)
    const r = setPluginEnabled({ profileDir: pr, profile: 're', name: '@deepseek-ai/dsh-base', enabled: true, checkout }, log)
    expect(r.ok).toBe(true)
    expect(listPlugins({ profileDir: pr, profile: 're', checkout }).find((p) => p.name === '@deepseek-ai/dsh-base')!.enabled).toBe(true)
  })

  it('reports the mutated mechanism: bundle for bundle-list ops, patch for inserts', () => {
    // Bundle-style enable → mechanism 'bundle' (takes effect at next boot).
    const pr = makeProfile('mech-bundle', [])
    const src = join(checkout, 'packages', 'bundle', 'base')
    installPluginModule({ profileDir: pr, profile: 'mech-bundle', name: '@deepseek-ai/dsh-base', source: src }, log)
    const dis = setPluginEnabled({ profileDir: pr, profile: 'mech-bundle', name: '@deepseek-ai/dsh-base', enabled: false, checkout }, log)
    expect(dis.mechanism).toBe('bundle')

    // Patch-insert (CLIENT plugin) enable → mechanism 'patch' (hot on a live DSH).
    const pool = join(home, 'profiles', 'node_modules')
    const pcDir = join(pool, 'dsh-precise-cache')
    mkdirSync(join(pcDir, 'lib'), { recursive: true })
    writeFileSync(join(pcDir, 'package.json'), JSON.stringify({
      name: 'dsh-precise-cache', version: '1.0.0', dsh: { client: { platform: 'web' } },
      exports: { './client': { default: './lib/client.js' } },
    }))
    writeFileSync(join(pcDir, 'lib', 'client.js'), 'window.__PC__ = 1\n')
    const en = setPluginEnabled({ profileDir: pr, profile: 'mech-bundle', name: 'dsh-precise-cache', enabled: true, poolDir: pool }, log)
    expect(en.mechanism).toBe('patch')
    const de = setPluginEnabled({ profileDir: pr, profile: 'mech-bundle', name: 'dsh-precise-cache', enabled: false, poolDir: pool }, log)
    expect(de.mechanism).toBe('patch')
  })

  it('refuses to enable a plugin whose module is not installed (would break the boot)', () => {
    const pr = makeProfile('noinst', [])
    const r = setPluginEnabled({ profileDir: pr, profile: 'noinst', name: '@deepseek-ai/dsh-base', enabled: true, checkout }, log)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('@deepseek-ai/dsh-base')
  })

  it('refuses to enable a non-bundle module (would crash DSH boot — the cosmokit regression)', () => {
    const pr = makeProfile('nobundle', [])
    // A dependency module in the pool WITHOUT dsh.bundle (like @deepseek-ai/cosmokit).
    const pool = join(home, 'profiles', 'node_modules')
    writeDshPlugin(join(pool, '@deepseek-ai', 'dsh-base'), '@deepseek-ai/dsh-base') // real bundle
    mkdirSync(join(pool, '@deepseek-ai', 'cosmokit'), { recursive: true })
    writeFileSync(join(pool, '@deepseek-ai', 'cosmokit', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cosmokit', version: '1.0.0' }))
    const r = setPluginEnabled({ profileDir: pr, profile: 'nobundle', name: '@deepseek-ai/cosmokit', enabled: true, poolDir: pool }, log)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('@deepseek-ai/cosmokit')
    // The bundle list must NOT contain cosmokit (adding it breaks boot).
    const after = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8'))
    expect((after.dsh?.profile?.bundles ?? []) as string[]).not.toContain('@deepseek-ai/cosmokit')
  })

  it('uninstall sanitizes a profile whose bundles list contains a non-bundle (repairs corruption)', () => {
    // Simulate the corruption: cosmokit was written into bundles by a bad op.
    const pr = makeProfile('corrupt', ['@deepseek-ai/dsh-base', '@deepseek-ai/cosmokit'])
    const pool = join(home, 'profiles', 'node_modules')
    writeDshPlugin(join(pool, '@deepseek-ai', 'dsh-base'), '@deepseek-ai/dsh-base')
    mkdirSync(join(pool, '@deepseek-ai', 'cosmokit'), { recursive: true })
    writeFileSync(join(pool, '@deepseek-ai', 'cosmokit', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cosmokit' }))
    // Uninstall any real plugin — the sanitize pass must drop the non-bundle.
    uninstallPlugin({ profileDir: pr, profile: 'corrupt', name: '@deepseek-ai/dsh-base', poolDir: pool }, log)
    const after = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8'))
    expect((after.dsh?.profile?.bundles ?? []) as string[]).not.toContain('@deepseek-ai/cosmokit')
  })
})

describe('uninstallPlugin (real DSH profile)', () => {
  it('removes the module and the bundle entry', () => {
    const pr = makeProfile('uni')
    const src = join(checkout, 'packages', 'bundle', 'base')
    installPluginModule({ profileDir: pr, profile: 'uni', name: '@deepseek-ai/dsh-base', source: src }, log)
    const r = uninstallPlugin({ profileDir: pr, profile: 'uni', name: '@deepseek-ai/dsh-base' }, log)
    expect(r.ok).toBe(true)
    expect(existsSync(join(pr, 'node_modules', '@deepseek-ai', 'dsh-base'))).toBe(false)
    // It still appears as installable-from-checkout, but no longer installed/enabled.
    const after = listPlugins({ profileDir: pr, profile: 'uni', checkout }).find((p) => p.name === '@deepseek-ai/dsh-base')
    expect(after?.installed).toBe(false)
    expect(after?.enabled).toBe(false)
  })

  it('is safe for an already-absent plugin', () => {
    const pr = makeProfile('none', ['@deepseek-ai/dsh-ghost'])
    const r = uninstallPlugin({ profileDir: pr, profile: 'none', name: '@deepseek-ai/dsh-ghost' }, log)
    expect(r.ok).toBe(true)
    expect(listPlugins({ profileDir: pr, profile: 'none', checkout }).find((p) => p.name === '@deepseek-ai/dsh-ghost')).toBeUndefined()
  })
})

describe('patch-insert plugin lifecycle (the dsh-precise-cache shape)', () => {
  it('disable removes the patch INSERT and uninstall clears the pool module', () => {
    // precise-cache: installed in the shared pool, enabled via cordis.patch.yml.
    const pr = makeProfile('precise')
    const pool = join(home, 'profiles', 'node_modules')
    writeDshPlugin(join(pool, 'dsh-precise-cache'), 'dsh-precise-cache')
    writeFileSync(join(pr, 'cordis.patch.yml'), '- insert:\n    - id: precise-cache\n      name: dsh-precise-cache\n')

    // It is listed as enabled (via patch insert).
    const infos = listPlugins({ profileDir: pr, profile: 'precise', poolDir: pool })
    const pc = infos.find((p) => p.name === 'dsh-precise-cache')!
    expect(pc.installed).toBe(true)
    expect(pc.enabled).toBe(true)

    // DISABLE removes the patch insert (it was not in dsh.profile.bundles).
    const r = setPluginEnabled({ profileDir: pr, profile: 'precise', name: 'dsh-precise-cache', enabled: false, poolDir: pool }, log)
    expect(r.ok).toBe(true)
    expect(listPlugins({ profileDir: pr, profile: 'precise', poolDir: pool }).find((p) => p.name === 'dsh-precise-cache')!.enabled).toBe(false)
    // The patch no longer references it.
    expect(readFileSync(join(pr, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-precise-cache')

    // UNINSTALL removes the pool module + keeps it gone.
    const ru = uninstallPlugin({ profileDir: pr, profile: 'precise', name: 'dsh-precise-cache', poolDir: pool }, log)
    expect(ru.ok).toBe(true)
    expect(existsSync(join(pool, 'dsh-precise-cache'))).toBe(false)
  })

  it('repairs a corrupted double-top-level patch into ONE valid document (the YAML end-of-stream regression)', () => {
    const pr = makeProfile('corrupt-patch')
    const pool = join(home, 'profiles', 'node_modules')
    writeDshPlugin(join(pool, 'dsh-precise-cache'), 'dsh-precise-cache')
    // A previously-wrongly-written file: TWO top-level YAML values ([] then an
    // insert block) — DSH rejects this with "end of the stream ... expected".
    writeFileSync(join(pr, 'cordis.patch.yml'), '# header\n[]\n\n[]\n\n- insert:\n    - id: precise-cache\n      name: dsh-precise-cache\n')

    // Any patch edit must collapse it to exactly one top-level YAML value.
    const r = setPluginEnabled({ profileDir: pr, profile: 'corrupt-patch', name: 'dsh-precise-cache', enabled: false, poolDir: pool }, log)
    expect(r.ok).toBe(true)
    const out = readFileSync(join(pr, 'cordis.patch.yml'), 'utf8').trim()
    // Only comment/blank lines + a single top-level YAML value.
    const nonComment = out.split(/\r?\n/).filter((l) => l.trim() !== '' && !/^\s*#/.test(l)).map((l) => l.trim())
    expect(nonComment.length).toBe(1) // exactly one top-level value
    expect(nonComment[0]).toBe('[]') // disabling the last patch plugin → empty list
    expect(out).not.toContain('dsh-precise-cache')
  })
})

describe('discoverPluginSources + pluginRowText', () => {
  it('discovers installable DSH packages from the checkout', () => {
    const sources = discoverPluginSources(checkout)
    const names = sources.map((s) => s.name)
    expect(names).toContain('@deepseek-ai/dsh-base')
    expect(names).toContain('@deepseek-ai/dsh-web-app')
    expect(names).toContain('@deepseek-ai/dsh-headless')
  })

  it('returns [] when there is no checkout', () => {
    expect(discoverPluginSources(undefined)).toEqual([])
  })

  it('pluginRowText shows `on` for an enabled plugin', () => {
    const t = makeT('zh')
    const txt = pluginRowText(t, { name: '@deepseek-ai/dsh-base', installed: true, enabled: true })
    expect(txt).toContain('@deepseek-ai/dsh-base')
    expect(txt).toContain('on')
  })

  it('pluginRowText shows `off` for an installed-but-disabled plugin and `avail` for a source', () => {
    const t = makeT('en')
    expect(pluginRowText(t, { name: 'x', installed: true, enabled: false })).toContain('off')
    expect(pluginRowText(t, { name: 'y', installed: false, enabled: false, source: 'z' })).toContain('avail')
  })
})
