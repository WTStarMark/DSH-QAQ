/**
 * Auto-mount the dsh-qaq backup plugin into a DSH profile (傻瓜式 part).
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileDir } from './paths.ts'
import { Logger } from './log.ts'

/** The dsh-qaq plugin package directory (this repo's packages/dsh-qaq). */
export function findQaqPluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // here is 'src' → root is the repo root → packages/dsh-qaq.
  const root = resolve(here, '..')
  return join(root, 'packages', 'dsh-qaq')
}

export interface InstallResult { ok: boolean; mounted: boolean; message: string }

export function installPlugin(home: string, profile: string, log: Logger): InstallResult {
  const plugin = findQaqPluginDir()
  const pkgPath = join(plugin, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, mounted: false, message: '找不到 dsh-qaq 插件包：' + plugin }
  const pluginPkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string }
  const name = pluginPkg.name
  if (!name) return { ok: false, mounted: false, message: 'dsh-qaq package.json 缺少 name' }

  const pr = profileDir(home, profile)
  const pjPath = join(pr, 'package.json')
  if (!existsSync(pjPath)) return { ok: false, mounted: false, message: 'profile ' + profile + ' 尚未初始化（目录 ' + pr + '）。' }

  // Keep the original so a failed step below can roll the profile back to
  // byte-identical content — a half-mounted plugin must never break the boot.
  const originalPkg = readFileSync(pjPath, 'utf8')
  let pkg: { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, unknown> }
  try { pkg = JSON.parse(originalPkg) } catch { return { ok: false, mounted: false, message: 'profile package.json 无法解析' } }
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
        log.warn('检测到 ' + profile + '/cordis.patch.yml 中仍有 ' + name + ' 的手动 insert 行。bundle 机制会自动加载该插件，残留行会导致 duplicate entry 启动失败，请手动删除该行。')
      }
    } catch { /* best effort */ }
  }

  // Link the plugin module into the profile so DSH can resolve it by name.
  const nmDir = join(pr, 'node_modules')
  let linkFailed = false
  if (!existsSync(join(nmDir, name, 'package.json'))) {
    try {
      mkdirSync(nmDir, { recursive: true })
      symlinkSync(plugin, join(nmDir, name), 'junction')
    } catch { linkFailed = true }
  }

  // The bundle list now references a module DSH must resolve. If we cannot
  // link it, undo the manifest write so the profile stays loadable (never
  // create the very boot failure this tool exists to guard against).
  if (linkFailed) {
    log.warn('无法建立 node_modules 链接：' + name + '（' + nmDir + '）；已撤销 manifest 写入，profile 未受影响。')
    return { ok: false, mounted: false, message: '无法将 dsh-qaq 链接进 profile 的 node_modules（' + nmDir + '），已撤销本次修改。请检查权限后重试。' }
  }

  // Apply the manifest write atomically: on failure, restore the original.
  try {
    if (!already) writeFileSync(pjPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  } catch {
    try { writeFileSync(pjPath, originalPkg, 'utf8') } catch { /* best effort */ }
    log.error('写入 profile manifest 失败，已回滚原始内容：' + name)
    return { ok: false, mounted: false, message: '写入 profile manifest 失败（' + pjPath + '），已回滚。请检查磁盘/权限后重试。' }
  }

  log.info('dsh-qaq 插件已挂载到 profile ' + profile + (already ? '（此前已挂载）' : '') + '（bundle layer）；下次干净启动会自动写 last-good 快照。')
  log.access('dsh-qaq plugin mounted on profile ' + profile + (already ? ' (already)' : ''), { profile, action: 'install-plugin', already })
  return { ok: true, mounted: true, message: '插件已挂载到 profile ' + profile + '（bundle layer），目录：' + pr }
}
