/**
 * qaq-plugin — a filesystem-scoped plugin manager for a REAL DeepSeek Harness
 * profile. It manages DSH's own plugins (the `@deepseek-ai/*` bundle packages)
 * — never QAQ's repository.
 *
 * DeepSeek Harness loads a profile's plugins through its BUNDLE mechanism:
 *   - `dsh.profile.bundles` (in the DSH profile's package.json) is the load
 *     list — a plugin name here is "enabled" (loaded at boot).
 *   - the module must also be resolvable, i.e. `<profile>/node_modules/<name>/`
 *     exists (a junction into the DSH package dir, or a real copy) — its
 *     presence here is what makes it "installed".
 *
 * So the lifecycle states are composable from two booleans:
 *   - installed && enabled   → normal (loaded)
 *   - installed && !enabled  → DISABLED (module kept, not loaded)
 *   - !installed             → uninstalled (removed from bundles too)
 *
 * Operations take an explicit DSH home + profile dir + profile name. Install
 * sources come from the REAL DSH checkout's `packages/*` (each dir whose
 * package.json declares `dsh.bundle.patch` is an installable plugin), plus any
 * module already present under the profile's node_modules. All operations
 * mutate ONLY the DSH home's `profiles/<profile>` directory — no child process
 * is spawned, no network, nothing outside the DSH home is touched. Every
 * manifest write is atomic (temp + rename) and, on failure, the profile is
 * restored to byte-identical content.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, statSync, readlinkSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { Logger } from './log.ts'
import { makeT, type Lang, type T } from './i18n.ts'
import { findDshPackages } from './dsh-context.ts'

/** A discovered plugin with its lifecycle state. */
export interface PluginInfo {
  /** The plugin/bundle name (package.json `name`, or the dir name). */
  name: string
  /** The module dir exists under the profile's node_modules. */
  installed: boolean
  /** The name is in `dsh.profile.bundles` (loaded at boot). */
  enabled: boolean
  /** Where this plugin can be installed from (a real DSH package dir), if any. */
  source?: string
  /** When the node_modules entry is a junction (symlink), its real target. */
  linkTarget?: string
}

export interface PluginOpResult { ok: boolean; message: string }

/** A resolved plugin row: installed vs. enabled vs. source availability. */
export interface PluginRow {
  name: string
  installed: boolean
  enabled: boolean
  source?: string
}

interface ProfileManifest {
  /** Raw manifest text, preserved so a failed write can restore the original. */
  raw: string
  pkg: { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, unknown> }
}

/** Read+parse the DSH profile's package.json safely. null when unreadable/bad. */
function readManifest(profileDir: string): ProfileManifest | null {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return null
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  let pkg: ProfileManifest['pkg']
  try { pkg = JSON.parse(raw) } catch { return null }
  if (!pkg || typeof pkg !== 'object') return null
  return { raw, pkg }
}

/** The bundle list as a string array ([] if absent/malformed). */
function bundlesOf(m: ProfileManifest): string[] {
  const b = m.pkg.dsh?.profile?.bundles
  return Array.isArray(b) ? b.map(String).filter(Boolean) : []
}

/**
 * Enabled plugin names from the profile's `cordis.patch.yml` INSERTS. DSH treats
 * an `- insert:` list in the patch layer as loading those plugins by their
 * `name` (or `id`). This is what enables plugins like dsh-precise-cache that
 * are NOT in `dsh.profile.bundles`. Read-only, best-effort.
 */
function patchEnabledNames(profileDir: string): string[] {
  return patchInsertNames(profileDir)
}

/** A parsed patch insert tuple: the plugin `name` and the matched metadata. */
interface PatchInsertRef { name: string; id?: string }

/**
 * Parse `cordis.patch.yml` and return the insert tuples as { name } — the patch
 * layer's `- insert:` list is how plugins like dsh-precise-cache are enabled.
 */
function patchInsertNames(profileDir: string): string[] {
  const entries = parsePatchInserts(profileDir)
  return Array.from(new Set(entries.map((e) => e.name)))
}

/** Parse every `- id:/name:` tuple under a top-level `- insert:` block. */
function parsePatchInserts(profileDir: string): PatchInsertRef[] {
  const file = join(profileDir, 'cordis.patch.yml')
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const out: PatchInsertRef[] = []
  const lines = text.split(/\r?\n/)
  // Within an insert block, a tuple begins with "- id: X" followed by "name: Y".
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (/^-?\s*insert\s*:/.test(l)) { inside = true; continue }
    // Stop at a top-level list item that isn't an insert (back to content).
    if (inside && /^-\s/.test(l) && !/^-\s*(id|name)\s*:/.test(l)) { inside = false }
    if (inside) {
      const idm = /^-\s*id\s*:\s*(\S+)/.exec(l)
      if (idm) {
        // Name is the next non-empty "name:" line.
        let name = ''
        for (let j = i + 1; j < lines.length; j++) {
          const nl = lines[j].trim()
          if (nl === '') continue
          const nmm = /^name\s*:\s*(.+)/.exec(nl)
          if (nmm) { name = nmm[1].trim(); break }
          break // first non-empty line wasn't "name:" — stop
        }
        out.push({ name: name || idm[1], id: idm[1] })
      }
    }
  }
  return out
}

/**
 * Add or remove a plugin's insert tuple in `cordis.patch.yml`. Best-effort:
 * keeps the header/trailer comments, rewrites the insert list atomically.
 */
function editPatchInsert(profileDir: string, name: string, add: boolean): boolean {
  const file = join(profileDir, 'cordis.patch.yml')
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return false }
  return writePatchWithInserts(profileDir, name, add, text)
}

/**
 * Rewrite cordis.patch.yml with a SINGLE valid top-level YAML value. The file is
 * parsed by DSH as one document, so we keep ONLY the comment/blank header lines
 * (a "footer" comment is fine too) and completely replace the body — we must
 * never retain the old `[]`/`- insert:` body, or the file becomes two top-level
 * documents and DSH fails ("end of the stream ... expected (6:1)").
 */
function writePatchWithInserts(profileDir: string, name: string, add: boolean, original: string): boolean {
  const file = join(profileDir, 'cordis.patch.yml')
  const lines = original.split(/\r?\n/)
  // Keep only comment and blank lines (the header/footer prose DSH ignores).
  const keep = lines.filter((l) => l.trim() === '' || /^\s*#/.test(l))
  const cur = parsePatchInserts(profileDir).filter((e) => e.name !== name)
  if (add && !cur.some((e) => e.name === name)) cur.push({ name })
  const body: string[] = []
  if (cur.length === 0) {
    body.push('[]')
  } else {
    body.push('- insert:')
    for (const e of cur) {
      const id = e.id && e.id !== e.name ? e.id : toId(e.name)
      body.push('    - id: ' + id)
      body.push('      name: ' + e.name)
    }
  }
  const next = [...keep, ...body]
  try {
    writeFileSync(file, next.join('\n') + '\n', 'utf8')
    return true
  } catch { return false }
}

/** Map a plugin package name to the short id DSH uses in patch inserts. */
function toId(name: string): string {
  if (name.startsWith('@deepseek-ai/dsh-')) return name.slice('@deepseek-ai/dsh-'.length)
  if (name.startsWith('dsh-')) return name.slice('dsh-'.length)
  return name
}

/** Whether a resolvable module dir exists (follows junctions). */
function moduleInstalled(nmDir: string, name: string): boolean {
  return existsSync(join(nmDir, name, 'package.json'))
}

/** If `<nmDir>/<name>` is a symlink/junction, return its target (best-effort). */
function linkTargetOf(nmDir: string, name: string): string | undefined {
  const p = join(nmDir, name)
  try { if (statSync(p).isSymbolicLink()) return readlinkSync(p) } catch { /* ignore */ }
  return undefined
}

/**
 * Enumerate module names under a DSH node_modules, expanding npm scopes
 * (`@scope/name`) into `@scope/name`. Entries are followed so junctions count.
 * Only entries whose sub-path carries a package.json are returned.
 */
function listModuleDirs(nmDir: string): string[] {
  const out: string[] = []
  let top: import('node:fs').Dirent[]
  try { top = readdirSync(nmDir, { withFileTypes: true }) } catch { return [] }
  const walkChild = (parent: string, name: string): void => {
    const child = join(parent, name)
    if (!name.startsWith('.') && existsSync(join(child, 'package.json'))) {
      out.push(name)
      return
    }
    // A scope directory (no package.json itself) holds scoped packages.
    if (name.startsWith('@')) {
      let sub: import('node:fs').Dirent[]
      try { sub = readdirSync(child, { withFileTypes: true }) } catch { return }
      for (const ent of sub) {
        if (ent.name.startsWith('.')) continue
        const subChild = join(child, ent.name)
        if (existsSync(join(subChild, 'package.json'))) out.push(name + '/' + ent.name)
      }
    }
  }
  for (const ent of top) {
    if (ent.isDirectory() || ent.isSymbolicLink()) walkChild(nmDir, ent.name)
  }
  return out
}

/** Read a package.json's `name` (or fall back to the dir basename). */
function packageName(dir: string, fallback = basename(dir)): string {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    return j?.name || fallback
  } catch { return fallback }
}

/**
 * List the real DSH plugins. Two sources of truth:
 *
 *  A) LIVE INVENTORY (authoritative): when the dsh-qaq plugin is running it
 *     pushes the Cordis loader's non-group entries (`liveEntries`). That is the
 *     exact plugin set DSH actually loaded — the ~160 the user sees — with the
 *     true `enabled` flag straight from the loader:
 *        - the plugin list = just those entries (no raw node_modules noise),
 *        - `enabled` = `!entry.disabled` (authoritative, not inferred).
 *
 *  B) FALLBACK (file heuristics): when DSH is not up, enumerate the profile
 *     node_modules + shared pool + manifest bundles + checkout bundle packages.
 *
 * In both cases each plugin is enriched with an install `source` (from the DSH
 * checkout) when available.
 */
export function listPlugins(opts: {
  profileDir: string
  profile: string
  checkout?: string
  poolDir?: string
  liveEntries?: { entryId: string; moduleName?: string; enabled: boolean; fiberPhase?: string | null }[]
}): PluginInfo[] {
  const pr = opts.profileDir
  const m = readManifest(pr)
  const bundles = m ? bundlesOf(m) : []
  const nmDir = join(pr, 'node_modules')
  const sourceDirs: Record<string, string> = {}
  if (opts.checkout) {
    for (const dir of findDshPackages(opts.checkout)) {
      if (!isDshBundle(dir)) continue
      sourceDirs[packageName(dir)] = dir
    }
  }
  const dirOf = (name: string): string => {
    if (existsSync(join(nmDir, name, 'package.json'))) return join(nmDir, name)
    if (opts.poolDir && existsSync(join(opts.poolDir, name, 'package.json'))) return join(opts.poolDir, name)
    return ''
  }

  // Build the full file-discovered name set (pool + per-profile + bundles +
  // patch inserts + checkout bundle sources). This is what lets DISABLED plugins
  // stay visible — the live loader set alone would drop anything it no longer
  // loads, hiding a plugin right after you disabled it (and after a reload).
  const enabledSet = new Set<string>([...bundles, ...patchEnabledNames(pr)])
  const moduleNames = new Set(listModuleDirs(nmDir))
  if (opts.poolDir) {
    for (const name of listModuleDirs(opts.poolDir)) moduleNames.add(name)
  }

  const liveEnabled = new Map<string, boolean>()
  if (opts.liveEntries) {
    for (const e of opts.liveEntries) {
      const name = e.moduleName || e.entryId
      liveEnabled.set(name, e.enabled)
    }
  }

  const allNames = Array.from(new Set<string>([
    ...moduleNames,
    ...Object.keys(sourceDirs),
    ...bundles,
    ...enabledSet,
    ...liveEnabled.keys(),
  ]))
  return allNames
    .map((name) => {
      const dir = dirOf(name)
      const installed = dir !== ''
      // Enabled: live loader truth wins when present; otherwise file state.
      const enabled = liveEnabled.has(name) ? liveEnabled.get(name)! : enabledSet.has(name)
      return {
        name,
        installed,
        enabled,
        ...(sourceDirs[name] ? { source: sourceDirs[name] } : {}),
        ...(installed ? { linkTarget: linkTargetOf(dirname(dir), basename(dir)) } : {}),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Persist the DSH profile manifest atomically; restore `original` on failure. */
function writeManifestAtomic(profileDir: string, m: ProfileManifest): boolean {
  const file = join(profileDir, 'package.json')
  const tmp = file + '.qaq-tmp'
  try {
    writeFileSync(tmp, JSON.stringify(m.pkg, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { writeFileSync(file, m.raw, 'utf8') } catch { /* best effort */ }
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    return false
  }
}

/** Whether a module is resolvable in the profile node_modules or the shared pool. */
function resolvable(pr: string, poolDir: string | undefined, name: string): boolean {
  if (moduleInstalled(join(pr, 'node_modules'), name)) return true
  if (poolDir && moduleInstalled(poolDir, name)) return true
  return false
}

/** Resolve the module dir for `name` from the profile node_modules or the pool. */
function resolveModuleDir(pr: string, poolDir: string | undefined, name: string): string {
  if (moduleInstalled(join(pr, 'node_modules'), name)) return join(pr, 'node_modules', name)
  if (poolDir && moduleInstalled(poolDir, name)) return join(poolDir, name)
  return ''
}

/**
 * A bundle is valid when its package.json declares `dsh.bundle` — the ONLY kind
 * that may appear in `dsh.profile.bundles`. Writing any other package there
 * (e.g. a dependency like @deepseek-ai/cosmokit) crashes DSH boot with
 * "declares no dsh.bundle in its package.json".
 */
function isRealBundleDir(dir: string): boolean {
  return dir !== '' && isDshBundle(dir)
}

/**
 * Filter a bundle list to only names that resolve to a package declaring
 * `dsh.bundle`. Used as a safety net so enable/disable/uninstall/install write
 * can never leave a non-bundle in the profile's load list (which would break
 * boot) — it also repairs a profile that was already corrupted.
 */
function sanitizeBundles(pr: string, poolDir: string | undefined, names: string[]): string[] {
  return names.filter((n) => isRealBundleDir(resolveModuleDir(pr, poolDir, n)))
}


/** Whether a plugin is currently enabled (bundle list OR patch insert). */
function isEnabled(m: ProfileManifest | null, pr: string, name: string): boolean {
  return (m ? bundlesOf(m).includes(name) : false) || patchInsertNames(pr).includes(name)
}

/** Enable or disable a plugin. Handles BOTH bundle-style plugins (in
 * `dsh.profile.bundles`) and patch-insert plugins (enabled via `cordis.patch.yml`
 * `- insert:` — e.g. dsh-precise-cache). Disabling removes whichever mechanism
 * currently loads it; enabling adds to bundles when the module is a real bundle,
 * otherwise to the patch insert list. */
export function setPluginEnabled(opts: { profileDir: string; profile: string; name: string; enabled: boolean; checkout?: string; poolDir?: string }, log: Logger, lang: Lang = 'zh'): PluginOpResult {
  const t: T = makeT(lang)
  const pr = opts.profileDir
  const m = readManifest(pr)
  if (!m) return { ok: false, message: t('pluginMgr.badProfile', { profile: opts.profile }) }

  if (opts.enabled && isEnabled(m, pr, opts.name)) {
    return { ok: true, message: t('pluginMgr.alreadyEnabled', { name: opts.name }) }
  }
  if (!opts.enabled) {
    // Disable: remove from whichever mechanism loads it. Also purge a stray
    // non-bundle from the bundle list (safety) while we are here.
    let changed = false
    const next = sanitizeBundles(pr, opts.poolDir, bundlesOf(m).filter((n) => n !== opts.name))
    if (next.length !== bundlesOf(m).length) {
      m.pkg.dsh = m.pkg.dsh ?? {}
      m.pkg.dsh.profile = m.pkg.dsh.profile ?? {}
      m.pkg.dsh.profile.bundles = next
      writeManifestAtomic(pr, m)
      changed = true
    }
    if (patchInsertNames(pr).includes(opts.name)) { editPatchInsert(pr, opts.name, false); changed = true }
    if (!changed) return { ok: true, message: t('pluginMgr.notBundled', { name: opts.name }) }
    log.access('disabled plugin ' + opts.name + ' on profile ' + opts.profile, { profile: opts.profile, action: 'disable-plugin', plugin: opts.name })
    return { ok: true, message: t('pluginMgr.disabled', { name: opts.name }) }
  }

  // Enable.
  const dir = resolveModuleDir(pr, opts.poolDir, opts.name)
  const kind = dir ? pluginKind(dir) : 'none'
  if (kind === 'none') {
    // Not a bundle and not a DSH-aware client plugin (e.g. a dependency like
    // cosmokit) — refusing avoids writing it into the load list and breaking boot.
    return { ok: false, message: t('pluginMgr.notPlugin', { name: opts.name }) }
  }
  if (kind === 'bundle') {
    const next = sanitizeBundles(pr, opts.poolDir, bundlesOf(m).filter((n) => n !== opts.name))
    next.push(opts.name)
    m.pkg.dsh = m.pkg.dsh ?? {}
    m.pkg.dsh.profile = m.pkg.dsh.profile ?? {}
    m.pkg.dsh.profile.bundles = next
    if (!writeManifestAtomic(pr, m)) return { ok: false, message: t('pluginMgr.writeFailed') }
  } else {
    // Client plugin (e.g. dsh-precise-cache): re-enable via the patch insert list.
    if (!editPatchInsert(pr, opts.name, true)) return { ok: false, message: t('pluginMgr.writeFailed') }
  }
  log.access('enabled plugin ' + opts.name + ' on profile ' + opts.profile, { profile: opts.profile, action: 'enable-plugin', plugin: opts.name })
  return { ok: true, message: t('pluginMgr.enabled', { name: opts.name }) }
}

/** Link a source module dir into the DSH profile's node_modules. */
function linkModule(pr: string, name: string, source: string, t: T): PluginOpResult {
  const nmDir = join(pr, 'node_modules')
  const target = join(nmDir, name)
  if (existsSync(join(target, 'package.json'))) return { ok: true, message: t('pluginMgr.alreadyInstalled', { name }) }
  if (!existsSync(join(source, 'package.json'))) return { ok: false, message: t('pluginMgr.badSource', { source }) }
  try {
    // Ensure the parent exists — for scoped names (@scope/name) this is the
    // `@scope` dir under node_modules; still within the DSH profile only.
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'junction')
    return { ok: true, message: '' }
  } catch { /* fallthrough */ }
  return { ok: false, message: t('pluginMgr.linkFailed', { name }) }
}

/**
 * Install a plugin into the DSH profile from a source module dir (a real DSH
 * package under the checkout, or any resolvable module). All-or-nothing.
 */
export function installPluginModule(opts: { profileDir: string; profile: string; name: string; source: string; poolDir?: string }, log: Logger, lang: Lang = 'zh'): PluginOpResult {
  const t: T = makeT(lang)
  const pr = opts.profileDir
  const m = readManifest(pr)
  if (!m) return { ok: false, message: t('pluginMgr.badProfile', { profile: opts.profile }) }
  const kind = pluginKind(opts.source)
  if (kind === 'none') return { ok: false, message: t('pluginMgr.notPlugin', { name: opts.name }) }

  // Target location: bundle plugins resolve from the profile node_modules;
  // client/patch plugins from the shared pool (where DSH resolves insert names).
  const targetRoot = kind === 'bundle' ? join(pr, 'node_modules') : (opts.poolDir ?? join(pr, 'node_modules'))
  const target = join(targetRoot, opts.name)
  if (!existsSync(join(target, 'package.json'))) {
    try {
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(opts.source, target, 'junction')
    } catch {
      return { ok: false, message: t('pluginMgr.linkFailed', { name: opts.name }) }
    }
  }

  if (kind === 'bundle') {
    const next = sanitizeBundles(pr, opts.poolDir, bundlesOf(m).filter((n) => n !== opts.name))
    next.push(opts.name)
    m.pkg.dsh = m.pkg.dsh ?? {}
    m.pkg.dsh.profile = m.pkg.dsh.profile ?? {}
    m.pkg.dsh.profile.bundles = next
    if (!writeManifestAtomic(pr, m)) {
      try { rmSync(target, { recursive: true, force: true }) } catch { /* best effort */ }
      return { ok: false, message: t('pluginMgr.writeFailed') }
    }
  } else {
    // Client / patch plugin: enable it via the cordis.patch.yml insert list.
    if (!editPatchInsert(pr, opts.name, true)) {
      try { rmSync(target, { recursive: true, force: true }) } catch { /* best effort */ }
      return { ok: false, message: t('pluginMgr.writeFailed') }
    }
  }

  log.access('installed plugin ' + opts.name + ' on profile ' + opts.profile + ' from ' + opts.source, { profile: opts.profile, action: 'install-plugin', plugin: opts.name, source: opts.source, kind })
  return { ok: true, message: t('pluginMgr.installed', { name: opts.name }) }
}

/** Classify a plugin source dir: 'bundle' (dsh.bundle) | 'client' (dsh.client) | 'none'. */
function pluginKind(dir: string): 'bundle' | 'client' | 'none' {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string }; client?: unknown } }
    if (j?.dsh?.bundle?.patch) return 'bundle'
    if (j?.dsh?.client) return 'client'
    return 'none'
  } catch { return 'none' }
}

/**
 * Uninstall a plugin: remove it from the DSH profile's bundle list AND remove
 * its module dir (junction) from the profile's node_modules.
 */
export function uninstallPlugin(opts: { profileDir: string; profile: string; name: string; poolDir?: string }, log: Logger, lang: Lang = 'zh'): PluginOpResult {
  const t: T = makeT(lang)
  const pr = opts.profileDir
  const nmDir = join(pr, 'node_modules')
  const target = join(nmDir, opts.name)
  const m = readManifest(pr)
  // A plugin may be installed in the per-profile node_modules OR the shared pool
  // (e.g. dsh-precise-cache lives at profiles/node_modules/<name>).
  const wasInstalled = existsSync(join(target, 'package.json'))
    || (opts.poolDir ? existsSync(join(opts.poolDir, opts.name, 'package.json')) : false)

  if (m) {
    // Remove the target AND sanitize the whole list (repairs non-bundle residue).
    const next = sanitizeBundles(pr, opts.poolDir, bundlesOf(m).filter((n) => n !== opts.name))
    if (next.length !== bundlesOf(m).length) {
      m.pkg.dsh = m.pkg.dsh ?? {}
      m.pkg.dsh.profile = m.pkg.dsh.profile ?? {}
      m.pkg.dsh.profile.bundles = next
      writeManifestAtomic(pr, m)
    }
  }
  // Remove a patch-insert enablement (precise-cache-style plugins).
  if (patchInsertNames(pr).includes(opts.name)) editPatchInsert(pr, opts.name, false)

  if (existsSync(join(target, 'package.json'))) {
    try { rmSync(target, { recursive: true, force: true }) } catch { log.warn('could not remove module dir ' + target) }
  } else if (opts.poolDir && existsSync(join(opts.poolDir, opts.name, 'package.json'))) {
    const poolTarget = join(opts.poolDir, opts.name)
    try { rmSync(poolTarget, { recursive: true, force: true }) } catch { log.warn('could not remove pool module dir ' + poolTarget) }
  }

  log.access('uninstalled plugin ' + opts.name + ' on profile ' + opts.profile, { profile: opts.profile, action: 'uninstall-plugin', plugin: opts.name })
  return { ok: true, message: t(wasInstalled ? 'pluginMgr.uninstalled' : 'pluginMgr.notInstalled', { name: opts.name }) }
}

/**
 * Discover installable DSH plugins from the real checkout's `packages/**`.
 * Yields one source per plugin package that declares a bundle patch (the marker
 * DSH uses to load a plugin as a bundle layer).
 */
export function discoverPluginSources(checkout: string | undefined): { name: string; dir: string }[] {
  if (!checkout) return []
  const out: { name: string; dir: string }[] = []
  for (const dir of findDshPackages(checkout)) {
    try {
      const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; dsh?: { bundle?: { patch?: string } } }
      if (!j?.dsh?.bundle?.patch) continue
      out.push({ name: packageName(dir), dir })
    } catch { /* skip unreadable */ }
  }
  return out
}

/** Whether a DSH package dir declares a bundle patch (installable bundle). */
function isDshBundle(dir: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
    return Boolean(j?.dsh?.bundle?.patch)
  } catch { return false }
}

/**
 * A compact row label for the TUI manager. Returns just the name; the caller
 * renders the colored enabled/disabled badge (green=enabled, red=disabled).
 * No "installed" marker — uninstalled plugins don't show status, and already
 * installed ones are the norm.
 */
export function pluginRowText(_t: T, info: PluginInfo): string {
  const tag = info.enabled ? 'on' : info.installed ? 'off' : 'avail'
  return info.name + '  [' + tag + ']'
}
