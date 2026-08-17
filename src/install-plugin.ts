/**
 * Auto-mount the dsh-qaq backup plugin into a DSH profile (懒人脚本 part).
 *
 * DSH loads a profile's plugins as BUNDLE LAYERS: each name in
 * `dsh.profile.bundles` is resolved, its package.json `dsh.bundle.patch` is
 * loaded as a patch layer, and its entry becomes part of the boot tree — the
 * same mechanism rollback-test.ps1 uses for dsh-broken-theme. So mounting is
 * exactly two steps: add `dsh-qaq` to the bundles list, and make the module
 * resolvable with a junction into the profile's node_modules. The profile's
 * own `cordis.patch.yml` (user layer) is NEVER touched: injecting a second
 * `id: dsh-qaq` row there would duplicate the bundle-layer entry and crash the
 * boot ("duplicate loader entry id") — a real bug caught by the integration
 * test. A stale manual insert row left by an older QAQ is only warned about.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileDir } from './paths.ts'
import { Logger } from './log.ts'
import { makeT, type Lang, type T } from './i18n.ts'

/** The dsh-qaq plugin package directory (this repo's packages/dsh-qaq). */
export function findQaqPluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // here is 'src' → root is the repo root → packages/dsh-qaq.
  const root = resolve(here, '..')
  return join(root, 'packages', 'dsh-qaq')
}

export interface InstallResult { ok: boolean; mounted: boolean; message: string }

export function installPlugin(home: string, profile: string, log: Logger, lang: Lang = 'zh'): InstallResult {
  const t: T = makeT(lang)
  const plugin = findQaqPluginDir()
  const pkgPath = join(plugin, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, mounted: false, message: t('plugin.notFound', { dir: plugin }) }
  const pluginPkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string }
  const name = pluginPkg.name
  if (!name) return { ok: false, mounted: false, message: t('plugin.noName') }

  // The mounted bundle loads lib/index.js at boot (junction -> this package dir).
  // lib/ is generated (not committed), so rebuild it first if it is missing or
  // older than the plugin source — a stale/missing lib would either silently run
  // old code (killing the `qaq watch` heartbeat discovery, P1) or fail the very
  // boot this tool exists to guard. Best-effort: any failure is reported, not swallowed.
  ensurePluginBuilt(plugin, t, log)

  const pr = profileDir(home, profile)
  const pjPath = join(pr, 'package.json')
  if (!existsSync(pjPath)) return { ok: false, mounted: false, message: t('plugin.noProfile', { name: profile, dir: pr }) }

  // Keep the original so a failed step below can roll the profile back to
  // byte-identical content — a half-mounted plugin must never break the boot.
  const originalPkg = readFileSync(pjPath, 'utf8')
  let pkg: { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, unknown> }
  try { pkg = JSON.parse(originalPkg) } catch { return { ok: false, mounted: false, message: t('plugin.badJson') } }
  const bundles = (pkg.dsh?.profile?.bundles ?? []) as string[]
  const already = bundles.includes(name)
  if (!already) {
    const nextBundles = Array.from(new Set([...bundles, name]))
    pkg.dsh = pkg.dsh ?? {}
    pkg.dsh.profile = pkg.dsh.profile ?? {}
    pkg.dsh.profile.bundles = nextBundles
  }

  // Warn about a stale manual insert row from an older QAQ: with the bundle
  // layer auto-loading the same entry id, a leftover user-layer row would
  // duplicate it and crash the boot. We never edit the user layer ourselves.
  const patchPath = join(pr, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    try {
      const patchText = readFileSync(patchPath, 'utf8')
      if (patchText.includes('id: ' + name) || patchText.includes('id:' + name)) {
        log.warn(t('plugin.staleInsert', { name, profile }))
      }
    } catch { /* best effort */ }
  }

  // Link the plugin module into the profile so DSH can resolve it by name.
  // The junction is VALIDATED, not just checked for existence: a link left by a
  // moved/reinstalled QAQ (or an orphan whose target directory vanished) would
  // keep loading OLD plugin code — defeating the very update this re-mount is
  // meant to deliver. Only a symlink/junction WE created may be replaced; a real
  // directory or file at the path is never touched (user data).
  const nmDir = join(pr, 'node_modules')
  const linkPath = join(nmDir, name)
  const linkTargetIsOurs = (): boolean => {
    try { return resolve(readlinkSync(linkPath)) === plugin } catch { return false }
  }
  // Existence WITHOUT following the link: a dangling junction (target deleted)
  // fails existsSync (which stats the target) yet still occupies the path and
  // must be replaced.
  const pathExists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }
  let linkFailed = false
  const linkValid = existsSync(join(linkPath, 'package.json')) && linkTargetIsOurs()
  if (!linkValid) {
    try {
      if (pathExists(linkPath)) {
        const st = lstatSync(linkPath)
        if (!st.isSymbolicLink()) throw new Error('path exists and is not a symlink: ' + linkPath)
        rmSync(linkPath, { recursive: true, force: true })
      }
      mkdirSync(nmDir, { recursive: true })
      symlinkSync(plugin, linkPath, 'junction')
    } catch { linkFailed = true }
  }

  // The bundle list now references a module DSH must resolve. If we cannot
  // link it, undo the manifest write so the profile stays loadable (never
  // create the very boot failure this tool exists to guard against).
  if (linkFailed) {
    log.warn(t('plugin.linkFailed', { name, dir: nmDir }))
    return { ok: false, mounted: false, message: t('plugin.linkFailedResult', { dir: nmDir }) }
  }

  // Apply the manifest write atomically: on failure, restore the original.
  try {
    if (!already) writeFileSync(pjPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  } catch {
    try { writeFileSync(pjPath, originalPkg, 'utf8') } catch { /* best effort */ }
    log.error(t('plugin.writeFailed', { name }))
    return { ok: false, mounted: false, message: t('plugin.writeFailedResult', { path: pjPath }) }
  }

  log.info(t('plugin.mountedLog', { name: profile, already: already ? t('plugin.already') : '' }))
  log.access('dsh-qaq plugin mounted on profile ' + profile + (already ? ' (already)' : ''), { profile, action: 'install-plugin', already })
  return { ok: true, mounted: true, message: t('plugin.mountedResult', { name: profile, dir: pr }) }
}

/**
 * Ensure the dsh-qaq plugin's lib/ build artifacts exist and are up to date with
 * its source before the module is mounted. lib/ is generated (not committed), so
 * a fresh clone or an editor-only change to the plugin source leaves it either
 * absent or stale. Rebuild in that case (or always when a refresh is requested),
 * using the same build.mjs that pnpm build runs. Best-effort: any failure is
 * surfaced to the operator rather than silently proceeding with a stale plugin.
 */
function ensurePluginBuilt(plugin: string, t: T, log: Logger): void {
  const libJs = join(plugin, 'lib', 'index.js')
  const srcTs = join(plugin, 'src', 'index.ts')
  try {
    if (existsSync(libJs) && existsSync(srcTs)) {
      const libMtime = statSyncMtime(libJs)
      const srcMtime = statSyncMtime(srcTs)
      if (libMtime >= srcMtime) return // already up to date
    }
    const buildScript = join(plugin, 'scripts', 'build.mjs')
    if (!existsSync(buildScript)) {
      log.warn('dsh-qaq build script missing at ' + buildScript + '; mounting with existing lib (if any)')
      return
    }
    log.info('dsh-qaq lib is missing/stale; rebuilding plugin (build.mjs)…')
    execFileSync(process.execPath, [buildScript], { cwd: plugin, stdio: 'inherit' })
  } catch (err) {
    log.warn('could not rebuild dsh-qaq plugin: ' + String(err instanceof Error ? err.message : err) + '. Mounting with existing lib (if any).')
  }
}

/** Best-effort mtime (ms) for a file; -1 when unreadable. */
function statSyncMtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}
