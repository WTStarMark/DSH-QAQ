/**
 * qaq-hot — plugin hot-update support for guard mode.
 *
 * Three independent channels, all best-effort, all disposable, and none of them
 * touches state.json / last-good / counters / the rollback fence (QAQ's core
 * capabilities stay untouched):
 *
 *  CHANNEL 2 (config layer): verifyPatchInsertApplied() — after a patch-insert
 *    enable/disable (cordis.patch.yml), poll the live plugin inventory pushed by
 *    the in-process dsh-qaq plugin to confirm the running DSH actually applied
 *    the change through its config HMR. Returns applied=true/false, or
 *    applied=null (reason 'offline') when DSH is down — nothing to verify, the
 *    change applies at next boot.
 *
 *  CHANNEL 1 (bundle layer): watchClientBundles() — watch each enabled client
 *    plugin's built bundle (exports["./client"], normally lib/client.js). DSH's
 *    own client-hmr stat-polls these files and hot-swaps the browser fiber;
 *    QAQ verifies the swap landed (UI probe + plugin inventory) and, on failure,
 *    restores a pre-change snapshot (hot-snapshots/) — the restore itself
 *    re-triggers client-hmr — then re-verifies.
 *
 *  CHANNEL 3 (pseudo-update): watchRestartTriggers() — watch the profile's
 *    dsh.profile.bundles list and the web frontend dist for changes and fire a
 *    callback; the TUI performs a supervised restart ("pseudo" hot update).
 *
 * Verification reuses the guard's own detectors (detector-ui, the plugin
 * inventory channel); the QAQ CLI stays the decision authority. Watchers live
 * inside the CLI/TUI process and always return a disposer.
 */
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync, readdirSync, rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { qaqDir, profileDir, profilesNodeModules } from './paths.ts'
import { readPluginHeartbeat, readPluginInventory, pushEvent, type LivePluginEntry } from './shared-io.ts'
import { patchInsertNames, resolveModuleDir, toId } from './plugin-manager.ts'
import { detectUi } from './detector-ui.ts'

/** Subdirectory under .qaq where pre-change hot-update snapshots live. */
export const HOT_SNAPSHOTS_DIR = 'hot-snapshots'

export function hotSnapshotsDir(home: string): string {
  return join(qaqDir(home), HOT_SNAPSHOTS_DIR)
}

/** Result of verifying a patch-insert (channel 2) change against a live DSH. */
export interface HotVerifyResult {
  /** true = applied live; false = still not applied; null = could not verify. */
  applied: boolean | null
  /** Present only when applied === null: why verification was skipped. */
  reason?: 'offline'
  /** Human-readable detail when applied === false. */
  detail?: string
}

/** One enabled client plugin's built bundle (the file DSH's client-hmr watches). */
export interface ClientBundleInfo {
  /** Package name (e.g. '@deepseek-ai/dsh-client-ui-theme'). */
  name: string
  /** Absolute package dir (the module as resolved from the profile). */
  pkgPath: string
  /** Absolute path of the built client bundle (exports["./client"]). */
  bundlePath: string
}

/** A hot-update watcher event (channel 1), surfaced to the TUI status panel. */
export interface HotWatchEvent {
  kind: 'changed' | 'verified' | 'rollback' | 'rollback-failed' | 'error'
  name?: string
  detail?: string
  ts: string
}

function newTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Whether a live DSH process is reporting through the dsh-qaq heartbeat. */
export function isDshOnline(home: string): boolean {
  return readPluginHeartbeat(home) !== null
}

/** Find a plugin entry in the live inventory by package name or short id. */
export function entryInInventory(home: string, name: string): LivePluginEntry | null {
  const inv = readPluginInventory(home)
  if (!inv?.entries) return null
  const short = toId(name)
  for (const e of inv.entries) {
    if (e.moduleName === name || e.entryId === name || e.entryId === short) return e
  }
  return null
}

/* ============================================================================
 * CHANNEL 2 — verify a patch-insert change landed on the running DSH
 * ========================================================================= */

export interface VerifyPatchInsertOptions {
  home: string
  /** The plugin package name that was toggled via cordis.patch.yml. */
  name: string
  /** The desired end state: true = enabled, false = disabled. */
  wantEnabled: boolean
  /** Total verification budget (ms). Default 4000. */
  waitMs?: number
  /** Inventory poll interval (ms). Default 500. */
  intervalMs?: number
}

/**
 * Poll the live plugin inventory until the running DSH reflects the desired
 * patch-insert state, or the budget expires. DSH's config HMR applies
 * cordis.patch.yml changes transactionally; a rejected recomposition leaves the
 * last good tree running (the guard's "never break the boot" posture), which is
 * exactly what `applied: false` reports.
 */
export async function verifyPatchInsertApplied(opts: VerifyPatchInsertOptions): Promise<HotVerifyResult> {
  const waitMs = opts.waitMs ?? 4000
  const intervalMs = opts.intervalMs ?? 500
  if (!isDshOnline(opts.home)) return { applied: null, reason: 'offline' }
  const deadline = Date.now() + waitMs
  let lastDetail: string | undefined
  while (Date.now() < deadline) {
    const entry = entryInInventory(opts.home, opts.name)
    if (opts.wantEnabled) {
      if (entry && entry.enabled) return { applied: true }
      lastDetail = entry ? 'entry present but not enabled' : 'entry not in inventory'
    } else {
      if (!entry || !entry.enabled) return { applied: true }
      lastDetail = 'entry still enabled'
    }
    await sleep(intervalMs)
  }
  return { applied: false, detail: lastDetail }
}

/* ============================================================================
 * Hot snapshot storage (pre-change content of hot-updated artifacts)
 * ========================================================================= */

/**
 * Persist `content` under hot-snapshots/<id>/<rel>. Returns the snapshot id, or
 * null on any failure (best-effort). `rel` may contain '/' (e.g. a scoped
 * plugin name), so parents are created.
 */
export function writeSnapshotText(home: string, rel: string, content: string): string | null {
  const id = newTimestamp()
  const target = join(hotSnapshotsDir(home), id, rel)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    return id
  } catch { return null }
}

/** Restore a snapshot's file to `abs`, bumping mtime so DSH's client-hmr
 *  stat-poll re-detects the change and hot-swaps back. Returns false on failure. */
export function restoreSnapshotText(home: string, id: string, rel: string, abs: string): boolean {
  const src = join(hotSnapshotsDir(home), id, rel)
  try {
    const content = readFileSync(src, 'utf8')
    writeFileSync(abs, content, 'utf8')
    const now = new Date()
    utimesSync(abs, now, now)
    return true
  } catch { return false }
}

/** List snapshot ids (newest first), or [] when none. */
export function listHotSnapshots(home: string): string[] {
  try {
    return readdirSync(hotSnapshotsDir(home)).sort().reverse()
  } catch { return [] }
}

/** Remove one snapshot set (best-effort). */
export function removeHotSnapshot(home: string, id: string): void {
  try { rmSync(join(hotSnapshotsDir(home), id), { recursive: true, force: true }) } catch { /* best effort */ }
}

/* ============================================================================
 * CHANNEL 1 — watch client-plugin bundles, verify the swap, roll back on failure
 * ========================================================================= */

/** The profile's dsh.profile.bundles list ([] when absent/unreadable). */
function readProfileBundles(pr: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const b = pkg?.dsh?.profile?.bundles
    return Array.isArray(b) ? b.map(String) : []
  } catch { return [] }
}

/** Resolve exports["./client"] to a relative path (string or { default } form). */
function clientBundleRel(pkg: { exports?: Record<string, unknown>; dsh?: { client?: unknown } }): string | null {
  const exp = pkg.exports?.['./client']
  if (typeof exp === 'string') return exp
  if (exp && typeof exp === 'object') {
    const def = (exp as Record<string, unknown>).default
    if (typeof def === 'string') return def
  }
  // A dsh.client plugin without an explicit client export uses the convention.
  if (pkg.dsh?.client) return 'lib/client.js'
  return null
}

/**
 * Resolve the built client bundle of every ENABLED plugin that has a client
 * half: the profile's bundle list plus cordis.patch.yml inserts, restricted to
 * packages that resolve to a module declaring dsh.client or exports["./client"].
 * These are exactly the files DSH's client-hmr stat-polls.
 */
export function resolveClientBundlePaths(opts: { home: string; profile: string; checkout?: string; poolDir?: string }): ClientBundleInfo[] {
  const pr = profileDir(opts.home, opts.profile)
  const poolDir = opts.poolDir ?? profilesNodeModules(opts.home)
  const names = Array.from(new Set([...readProfileBundles(pr), ...patchInsertNames(pr)]))
  const out: ClientBundleInfo[] = []
  for (const name of names) {
    const pkgDir = resolveModuleDir(pr, poolDir, name)
    if (!pkgDir) continue
    let pkg: { exports?: Record<string, unknown>; dsh?: { client?: unknown } }
    try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { continue }
    const rel = clientBundleRel(pkg)
    if (!rel) continue // not a client plugin
    out.push({ name, pkgPath: pkgDir, bundlePath: join(pkgDir, rel) })
  }
  return out
}

/** Default swap verification: the UI still boots healthy AND the entry is still
 *  enabled in the live inventory. A UI probe needs the plugin-reported port. */
async function defaultVerify(home: string, bundle: ClientBundleInfo): Promise<boolean> {
  const hb = readPluginHeartbeat(home)
  const entry = entryInInventory(home, bundle.name)
  const entryOk = entry ? entry.enabled : true
  if (hb?.port) {
    try {
      const ui = await detectUi('http://127.0.0.1:' + hb.port, 15000)
      return ui.kind === 'ok' && entryOk
    } catch { return false }
  }
  return entryOk
}

export interface WatchClientBundlesOptions {
  home: string
  profile: string
  checkout?: string
  poolDir?: string
  /** Bundle scan interval (ms). Default 1500 — comfortably above DSH's own
   *  500ms client-hmr stat-poll, so verification starts after the swap. */
  pollMs?: number
  /** How long to wait for the hot swap / re-swap before verifying (ms). Default 3000. */
  settleMs?: number
  /** Verify hook — injectable for tests. Default: UI probe + inventory. */
  verify?: (bundle: ClientBundleInfo) => Promise<boolean>
  onEvent?: (e: HotWatchEvent) => void
}

/**
 * Watch every enabled client plugin's bundle. On a content change: snapshot the
 * PRE-change content, wait for DSH's client-hmr to hot-swap, verify; on failure
 * restore the snapshot (which re-triggers client-hmr), re-verify, and report
 * 'rollback' or 'rollback-failed'. Returns a disposer.
 */
export function watchClientBundles(opts: WatchClientBundlesOptions): () => void {
  const pollMs = opts.pollMs ?? 1500
  const settleMs = opts.settleMs ?? 3000
  const home = opts.home
  const verify = opts.verify ?? ((b: ClientBundleInfo) => defaultVerify(home, b))
  const emit = opts.onEvent ?? (() => {})
  const event = (kind: HotWatchEvent['kind'], name?: string, detail?: string): void => {
    emit({ kind, name, detail, ts: new Date().toISOString() })
    pushEvent(home, 'hot-' + kind, opts.profile, { name, detail })
  }

  interface Baseline { mtimeMs: number; size: number; content: string }
  const baseline = new Map<string, { bundle: ClientBundleInfo; stat: Baseline }>()

  const snapshotFor = (b: ClientBundleInfo): Baseline | null => {
    try {
      const st = statSync(b.bundlePath)
      const base: Baseline = { mtimeMs: st.mtimeMs, size: st.size, content: readFileSync(b.bundlePath, 'utf8') }
      baseline.set(b.bundlePath, { bundle: b, stat: base })
      return base
    } catch { return null }
  }

  const refreshSet = (): ClientBundleInfo[] => {
    const fresh = resolveClientBundlePaths(opts)
    const paths = new Set(fresh.map((b) => b.bundlePath))
    for (const p of [...baseline.keys()]) if (!paths.has(p)) baseline.delete(p)
    for (const b of fresh) if (!baseline.has(b.bundlePath)) snapshotFor(b)
    return fresh
  }

  const handleChange = async (b: ClientBundleInfo, prev: Baseline): Promise<void> => {
    const rel = b.name + '/client.js'
    const snapId = writeSnapshotText(home, rel, prev.content)
    event('changed', b.name)
    await sleep(settleMs)
    if (await verify(b)) { event('verified', b.name); return }
    if (snapId === null || !restoreSnapshotText(home, snapId, rel, b.bundlePath)) {
      event('error', b.name, 'no pre-change snapshot to restore')
      return
    }
    event('rollback', b.name, 'restored pre-change bundle')
    await sleep(settleMs)
    if (await verify(b)) return
    event('rollback-failed', b.name, 'UI still unhealthy after restore')
  }

  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        for (const b of refreshSet()) {
          const prev = baseline.get(b.bundlePath)?.stat
          if (!prev) continue
          let cur: { mtimeMs: number; size: number } | null = null
          try {
            const st = statSync(b.bundlePath)
            cur = { mtimeMs: st.mtimeMs, size: st.size }
          } catch { /* missing — skip */ }
          if (!cur || (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size)) continue
          // Content changed: capture the NEW stat/content as the fresh baseline
          // first (the old content was already snapshotted inside handleChange
          // from `prev`), then process.
          const fresh = snapshotFor(b)
          await handleChange(b, prev)
          // Re-snapshot the CURRENT content so the next change's snapshot is
          // this (now verified) version.
          if (fresh) { /* snapshotFor already stored it */ }
        }
      } finally {
        busy = false
      }
    })()
  }, pollMs)
  timer.unref?.()

  return () => clearInterval(timer)
}

/* ============================================================================
 * CHANNEL 3 — pseudo-update: watch bundle-list / web-dist changes for a
 * supervised restart (the TUI owns the actual restart).
 * ========================================================================= */

/** Locate the built web frontend dist (checkout layouts). Null when unknown. */
export function resolveWebDistDir(opts: { checkout?: string }): string | null {
  if (!opts.checkout) return null
  const candidates = [
    join(opts.checkout, 'apps', 'web', 'dist'),
    join(opts.checkout, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** The profile's bundle list as a stable fingerprint string. */
function bundlesFingerprint(pr: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(pr, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    return JSON.stringify(pkg?.dsh?.profile?.bundles ?? [])
  } catch { return '' }
}

/** dist/index.html mtime+size fingerprint (a web rebuild rewrites it). */
function distFingerprint(distDir: string): string {
  try {
    const st = statSync(join(distDir, 'index.html'))
    return st.mtimeMs + ':' + st.size
  } catch { return '' }
}

export interface RestartTriggerOptions {
  home: string
  profile: string
  checkout?: string
  /** Watch dsh.profile.bundles changes (requires a restart to apply). */
  watchBundles: boolean
  /** Watch the web frontend dist (a rebuild requires a page reload/restart). */
  watchDist: boolean
  pollMs?: number
  /** Debounce after the last change before firing (ms). Default 2500. */
  debounceMs?: number
  /** Fired once a change has been stable for the debounce window. */
  onTrigger: (reason: 'bundles' | 'dist', detail?: string) => void
}

/**
 * Watch the two cold-apply inputs and fire onTrigger after a stable change
 * window. The TUI uses this to perform a supervised restart ("pseudo" update).
 * Returns a disposer. Dist watching is silently skipped when the dist cannot be
 * resolved (no checkout or no built dist).
 */
export function watchRestartTriggers(opts: RestartTriggerOptions): () => void {
  const pollMs = opts.pollMs ?? 1500
  const debounceMs = opts.debounceMs ?? 2500
  const pr = profileDir(opts.home, opts.profile)
  let bundlesFp = bundlesFingerprint(pr)
  const distDir = opts.watchDist ? resolveWebDistDir({ checkout: opts.checkout }) : null
  let distFp = distDir ? distFingerprint(distDir) : null
  let pendingBundles: number | null = null
  let pendingDist: number | null = null

  const timer = setInterval(() => {
    if (opts.watchBundles) {
      const fp = bundlesFingerprint(pr)
      if (fp !== bundlesFp) { bundlesFp = fp; pendingBundles = Date.now() }
      else if (pendingBundles !== null && Date.now() - pendingBundles >= debounceMs) {
        pendingBundles = null
        opts.onTrigger('bundles')
      }
    }
    if (opts.watchDist && distDir) {
      const fp = distFingerprint(distDir)
      if (fp !== distFp) { distFp = fp; pendingDist = Date.now() }
      else if (pendingDist !== null && Date.now() - pendingDist >= debounceMs) {
        pendingDist = null
        opts.onTrigger('dist', distDir)
      }
    }
  }, pollMs)
  timer.unref?.()

  return () => clearInterval(timer)
}
