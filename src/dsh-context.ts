/**
 * qaq-dsh-context — resolve the REAL DeepSeek Harness installation that the
 * plugin manager (and the TUI) should operate on.
 *
 * This is what makes the plugin manager manage DSH's own plugins instead of
 * QAQ's: it resolves WHERE the actual DeepSeek Harness lives:
 *   - the DSH home (profiles live under it): `$DSH_HOME` else `~/.dsh`
 *   - the DSH source checkout (its `packages/**` are the real plugin/bundle
 *     packages): discovered via `QAQ_DSH_CMD`, an explicit `--cwd`, an ancestor
 *     scan from the working dir, a sibling checkout next to it, or PATH.
 *   - whether a genuine DSH process is currently up (reported by the in-process
 *     dsh-qaq plugin heartbeat under the home's `.qaq/shared/`, not by probing
 *     the OS process table — no process API is touched).
 *
 * Standard resolution order (mirrors env.ts):
 *     1. explicit DSH_HOME / --cwd (authoritative when given)
 *     2. a nearby DSH checkout (ancestor + sibling) or the dsh binary on PATH
 *
 * The TUI uses this to scan the real DSH packages and manage them in the real
 * profile — never QAQ's own repository.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { resolveDshHome, profileDir as rawProfileDir, profilesNodeModules } from './paths.ts'
import { findAutoCheckout, findCheckoutCli } from './env.ts'
import { readPluginHeartbeat, readPluginInventory, readPluginConnection } from './shared-io.ts'
import type { PluginInventory } from './shared-io.ts'

/** A resolved, real DSH installation to manage. */
export interface DshContext {
  /** DSH home (config/profiles root). */
  home: string
  /** Active profile name (defaults to `web`). */
  profile: string
  /** The DSH profile directory (home/profiles/<profile>). */
  profileDir: string
  /** The shared module pool where the launcher installs DSH plugins
   *  (home/profiles/node_modules). Most real `@deepseek-ai/dsh-*` plugins live
   *  here rather than in the per-profile node_modules. */
  poolDir: string
  /** DSH source checkout root, when discoverable (provides the real packages). */
  checkout?: string
  /** Where the checkout was found (for user-facing display). */
  checkoutSource?: 'cwd' | 'sibling' | 'env' | 'none'
  /** Whether a genuine DSH process is currently up (plugin heartbeat, fresh). */
  processUp: boolean
  /** The current process's reported pid, from the heartbeat, when up. */
  processPid?: number
  /** The process's reported web port, from the heartbeat, when up. */
  processPort?: number
  /** The live plugin inventory pushed by the in-process dsh-qaq plugin (the
   *  authoritative plugin set), when fresh. Null when DSH is down / not
   *  reporting. */
  liveInventory?: PluginInventory | null
  /** Real, communicating connectivity with the in-process dsh-qaq plugin. */
  connection: import('./shared-io.ts').PluginConnectionInfo
}

export interface ResolveContextOptions {
  /** Explicit DSH home override (else $DSH_HOME / ~/.dsh). */
  home?: string
  /** Explicit checkout root override (else auto-discovery). */
  checkout?: string
  /** Profile name. */
  profile?: string
  /** Working directory to start the checkout ancestor/sibling scan from. */
  cwd?: string
}

/**
 * DSH package dirs under a checkout that look like plugin/bundle packages.
 * DSH lays its packages out as `packages/<group>/<name>` (e.g. `bundle/base`,
 * `boot/web`), so we walk the tree a few levels deep and keep any dir whose
 * package.json exists.
 */
export function findDshPackages(checkout: string): string[] {
  const root = join(checkout, 'packages')
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    // A package dir has a package.json at its own level.
    if (existsSync(join(dir, 'package.json'))) { out.push(dir); return }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue
      walk(join(dir, ent.name), depth + 1)
    }
  }
  walk(root, 0)
  return out.sort()
}

/** Resolve the real DSH installation. Pure filesystem checks; no process API. */
export function resolveDshContext(opts: ResolveContextOptions = {}): DshContext {
  const home = resolveDshHome()
  const profile = opts.profile ?? 'web'
  let checkout: string | undefined
  let checkoutSource: DshContext['checkoutSource'] = 'none'

  // 1) Explicit checkout / cli override.
  if (opts.checkout) {
    const abs = resolve(opts.checkout)
    if (existsSync(abs)) { checkout = abs; checkoutSource = 'env' }
  }
  // 2) Auto-discovery: ancestor + sibling checkout, or the CLI entry.
  if (!checkout) {
    const fromCwd = opts.cwd ?? process.cwd()
    let root: string | null = null
    // Ancestor scan for a checkout that contains apps/cli.
    let dir = resolve(fromCwd)
    for (let i = 0; i < 5 && root === null; i++) {
      if (findCheckoutCli(dir)) { root = dir; checkoutSource = 'cwd'; break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // Sibling scan (the "tool beside the checkout" layout).
    if (!root) {
      const parent = dirname(resolve(fromCwd))
      if (parent !== resolve(fromCwd)) {
        try {
          for (const ent of readdirSync(parent, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue
            const candidate = join(parent, ent.name)
            if (findCheckoutCli(candidate)) { root = candidate; checkoutSource = 'sibling'; break }
          }
        } catch { /* unreadable parent */ }
      }
    }
    if (root) checkout = root
    else {
      // Last resort: the env.ts auto-checkout (same logic) for a root.
      const auto = findAutoCheckout()
      if (auto) { checkout = auto.root; checkoutSource = 'sibling' }
    }
  }

  // A real DSH process is "up" when the in-process plugin heartbeat is fresh
  // under the DSH home. No OS process table is touched.
  let processUp = false
  let processPid: number | undefined
  let processPort: number | undefined
  const hb = readPluginHeartbeat(home)
  if (hb) { processUp = true; processPid = hb.pid; processPort = hb.port }

  // The authoritative live plugin inventory (only meaningful while DSH is up).
  const liveInventory = readPluginInventory(home)
  // Real, communicating connectivity with the in-process dsh-qaq plugin.
  const connection = readPluginConnection(home)

  return {
    home,
    profile,
    profileDir: rawProfileDir(home, profile),
    poolDir: profilesNodeModules(home),
    checkout,
    checkoutSource,
    processUp,
    processPid,
    processPort,
    liveInventory,
    connection,
  }
}

/** Human-readable one-liner describing where the real DSH was found. */
export function describeDsh(ctx: DshContext): string {
  const parts: string[] = []
  parts.push('home=' + ctx.home)
  if (ctx.checkout) parts.push('checkout=' + ctx.checkout + ' (' + ctx.checkoutSource + ')')
  if (ctx.processUp) parts.push('pid=' + (ctx.processPid ?? '?') + (ctx.processPort ? ' port=' + ctx.processPort : ''))
  else if (ctx.checkout || ctx.home) parts.push('process=down')
  return parts.join(' · ')
}

/** The short profile display name (basename of the profile dir). */
export function profileBasename(ctx: DshContext): string {
  return basename(ctx.profileDir)
}
