/**
 * dsh-qaq — QAQ backup + presence plugin. Mounts in a DSH profile and snapshots
 * the profile's startup config (package.json bundle list + cordis.patch.yml)
 * into ~/.dsh/.qaq/latest-good and the AUTO set history/auto/. TRUE BACKUP
 * POLICY: the snapshot is written ONLY after a real human conversation (a
 * `user/message` event with `source.kind === 'user'`) — the strongest proof the
 * boot is actually usable, so a host that settles but renders a broken web UI is
 * never recorded as good. Until such a conversation happens, no last-good is
 * written. Backup-only: it never detects failure, rolls back, or changes DSH
 * behavior.
 *
 * Presence channel (same layout as QAQ src/shared-io.ts, inlined here so the
 * plugin stays ZERO-runtime-dependency): while DSH is alive the plugin writes a
 * heartbeat + an in-process health state to <home>/.dsh/.qaq/shared/, so an
 * external QAQ CLI guard can discover and watch a DSH that *someone else*
 * launched (desktop / pnpm dsh web / a service) — including an OS-picked port
 * that only this in-process plugin can report. The CLI is the only decision
 * authority; the plugin never touches state.json or profile config beyond its
 * user-conversation-gated snapshot backup.
 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { copyFileSync, mkdirSync, writeFileSync, appendFileSync, renameSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-qaq'

/** Inline equivalent of @deepseek-ai/dsh-home-paths' resolveDshHome: a non-empty
 * DSH_HOME wins, otherwise ~/.dsh. Inlined (instead of imported) so the plugin
 * has ZERO runtime dependencies: it is mounted into a profile via a junction
 * from outside the DSH tree, and a bare-specifier import would walk up the
 * QAQ repo's node_modules — which never contains @deepseek-ai — and fail the
 * very boot this tool exists to guard. */
function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(selected)
}

const QAQ_DIR = '.qaq'
const SHARED_DIR = 'shared'
const HEARTBEAT_FILE = 'plugin-heartbeat.json'
const PLUGIN_STATE_FILE = 'plugin-state.json'
const EVENTS_FILE = 'events.jsonl'
/** Auto backup set: history/auto/ with an independent 10-snapshot quota
 *  (mirrors QAQ src/store.ts AUTO_BACKUP_*; the plugin is ZERO-dependency and
 *  cannot import them, so they are inlined). */
const AUTO_KEEP = 10
const AUTO_DIR = 'history/auto'
const FILES = ['package.json', 'cordis.patch.yml'] as const
const CHANNEL_VERSION = 1
/** How often the plugin refreshes the presence heartbeat while DSH is up.
 * Kept well under the CLI guard's 15s freshness window (see shared-io.ts
 * readPluginHeartbeat maxAgeMs) so a running DSH is always discoverable by
 * `qaq watch`. .unref()d so the timer never holds the host process open. */
const HEARTBEAT_INTERVAL_MS = (() => {
  // Injectable for tests (and tunable by operators); keeps the default 5s for
  // production, comfortably under the CLI's 15s freshness window.
  const v = Number(process.env.QAQ_HEARTBEAT_INTERVAL_MS)
  return Number.isFinite(v) && v > 0 ? v : 5000
})()

function newTimestamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

/** Best-effort atomic JSON write (temp + rename). Never throws. */
function writeJsonQuiet(file: string, value: unknown): void {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* best effort */ }
}

/** Best-effort append of an event line. Never throws. */
function pushSharedEvent(home: string, kind: string, profile: string | undefined, data: Record<string, unknown> = {}): void {
  try {
    const dir = join(home, QAQ_DIR, SHARED_DIR)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, EVENTS_FILE), JSON.stringify({
      seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      ts: new Date().toISOString(),
      kind, profile, data,
    }) + '\n', 'utf8')
  } catch { /* best effort */ }
}

/** Write the plugin heartbeat (in-process source of truth for "DSH is up"). */
function writeHeartbeat(home: string, ctx: Context, profileName: string): void {
  try {
    const dir = join(home, QAQ_DIR, SHARED_DIR)
    mkdirSync(dir, { recursive: true })
    writeJsonQuiet(join(dir, HEARTBEAT_FILE), {
      ts: new Date().toISOString(),
      pid: process.pid,
      profile: profileName,
      port: (ctx.get as (k: string) => any)?.('webServer')?.port,
      startedAt: new Date(Date.now() - Math.min(process.uptime() * 1000, 86400000)).toISOString(),
      version: CHANNEL_VERSION,
    })
  } catch { /* best effort */ }
}

/**
 * Keep the presence heartbeat fresh for as long as DSH is alive. The CLI guard
 * rejects a heartbeat older than 15s (readPluginHeartbeat maxAgeMs), so the
 * plugin must keep writing it AFTER the one-shot writes in apply() — otherwise
 * `qaq watch` loses the port for any DSH that has run longer than that window
 * (a real bug: the header once promised a "periodic" heartbeat that no code
 * delivered). The timer is .unref()ed so it can never keep the DSH host process
 * from exiting — DSH behavior is never changed.
 */
function startHeartbeatRefresh(home: string, profileName: string, ctx: Context): void {
  // Refresh every channel the external CLI uses to gauge connectivity: heartbeat
  // (pid/port) plus the plugin inventory + state. The inventory/state are the
  // authoritative enabled/phase truth — if we only write them once at settle,
  // they go stale after ~60s and the external "connected" indicator wrongly
  // degrades to "connecting". Keeping all three fresh keeps the connection real.
  const timer = setInterval(() => {
    refreshChannels(home, profileName, ctx)
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
}

/** Write heartbeat + inventory + state together (fresh on the same cadence). */
function refreshChannels(home: string, profileName: string, ctx: Context): void {
  writeHeartbeat(home, ctx, profileName)
  writePluginInventory(home, profileName, ctx)
  writePluginState(home, profileName, ctx, true, null)
}

function prune(historyDir: string, keep: number): void {
  let names: string[]
  try { names = readdirSync(historyDir) } catch { return }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const n of names.slice(keep)) {
    try { rmSync(join(historyDir, n), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function writeSnapshotHome(home: string, profileName: string, profileDir: string): void {
  const root = join(home, QAQ_DIR)
  mkdirSync(join(root, 'latest-good'), { recursive: true })
  mkdirSync(join(root, AUTO_DIR), { recursive: true })
  const ts = newTimestamp()
  const snapDir = join(root, AUTO_DIR, ts)
  mkdirSync(snapDir, { recursive: true })
  for (const f of FILES) {
    const src = join(profileDir, f)
    if (existsSync(src)) {
      copyFileSync(src, join(root, 'latest-good', f))
      copyFileSync(src, join(snapDir, f))
    }
  }
  const manifest = JSON.stringify({ profile: profileName, kind: 'auto', ts: new Date().toISOString() }, null, 2)
  writeFileSync(join(root, 'latest-good', 'manifest.json'), manifest, 'utf8')
  writeFileSync(join(snapDir, 'manifest.json'), manifest, 'utf8')
  prune(join(root, AUTO_DIR), AUTO_KEEP)
}

/**
 * A real user conversation happened on the session surface: a `user/message`
 * whose `source.kind` is `'user'` (a direct human prompt). Injected context
 * (`source.kind === 'plugin'`) and derived messages are NOT user conversations.
 * DSH is a host-side, zero-dependency consumer here: we read the event shape
 * defensively and never import any package.
 */
interface SessionEventShape { type?: string; data?: { source?: ({ kind?: string } & Record<string, unknown>); content?: unknown } & Record<string, unknown> }

/** True iff a session event is a genuine human user message. */
export function isUserConversation(event: SessionEventShape | undefined | null): boolean {
  return !!event && event.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * Wait for the loader tree to settle, then report presence/health to the shared
 * channel. BACKUP POLICY (true backup): the last-good snapshot is written ONLY
 * when a real user conversation occurs — a direct `user/message` from a human —
 * because only then is the boot provably usable (a host that settles but renders
 * a web boot red screen never lets the user talk, so it is never recorded as
 * good). A failed boot (rejected settle) is never snapshoted either.
 */
export function apply(ctx: Context): void {
  const home = resolveDshHome()
  const profileName = process.env.QAQ_PROFILE ?? inferProfileName() ?? 'web'
  const profileDir = join(home, 'profiles', profileName)
  const settle = (ctx.get as (k: string) => any)?.('loader')?.await?.()

  // Presence heartbeat NOW (DSH is booting / alive) so an external `qaq watch`
  // can discover the port immediately, then keep refreshing it periodically.
  // The heartbeat is a presence/health signal only — it never touches last-good.
  writeHeartbeat(home, ctx, profileName)
  startHeartbeatRefresh(home, profileName, ctx)

  // Arm the true-backup gate: only a genuine human user message marks the
  // profile as good. Listening globally (matching session-invariant) so the
  // bundle-layer plugin observes every session's event feed.
  const onSessionEvent = (session: unknown, event: unknown): void => {
    if (!isUserConversation(event as SessionEventShape)) return
    if (!existsSync(join(profileDir, 'package.json'))) return
    writeSnapshotHome(home, profileName, profileDir)
    writePluginState(home, profileName, ctx, true, null)
    writePluginInventory(home, profileName, ctx)
    writeHeartbeat(home, ctx, profileName)
    pushSharedEvent(home, 'dsh-user-conversation', profileName, { snapshot: true })
  }
  try { ctx.on('session/event', onSessionEvent, { global: true }) } catch { /* best effort */ }

  if (settle === undefined) {
    writePluginState(home, profileName, ctx, true, null)
    writePluginInventory(home, profileName, ctx)
    return
  }
  void settle.then(() => {
    writePluginState(home, profileName, ctx, true, null)
    const count = writePluginInventory(home, profileName, ctx)
    writeHeartbeat(home, ctx, profileName)
    pushSharedEvent(home, 'dsh-settled', profileName, { snapshot: false, pluginCount: count })
  }).catch((err: unknown) => {
    // Do NOT snapshot a failed boot. Do report the in-process failure signal so
    // an external guard that did not spawn this DSH can still count + roll back.
    const msg = (err instanceof Error ? String(err.message ?? '') : String(err)).slice(0, 300)
    writePluginState(home, profileName, ctx, false, msg)
    pushSharedEvent(home, 'dsh-boot-failed', profileName, { error: msg })
  })
}

/** Report in-process health (best-effort; the CLI treats this as advisory only). */
function writePluginState(home: string, profileName: string, ctx: Context, settled: boolean, failedMarker: string | null): void {
  try {
    const dir = join(home, QAQ_DIR, SHARED_DIR)
    mkdirSync(dir, { recursive: true })
    writeJsonQuiet(join(dir, PLUGIN_STATE_FILE), {
      ts: new Date().toISOString(),
      profile: profileName,
      settled,
      failedMarker,
      profileOk: existsSync(join(home, 'profiles', profileName, 'package.json')),
      // The bundle list snapshot at boot (mirrors the profile manifest).
      bundles: readBundles(home, profileName),
    })
  } catch { /* best effort */ }
}

/** The plugin-inventory channel file written by the live plugin. */
const PLUGIN_INVENTORY_FILE = 'plugin-inventory.json'

/** A live plugin entry captured straight from the Cordis loader. This is the
 * AUTHORITATIVE in-process truth: { entryId, moduleName, enabled, fiberPhase }.
 * Groups are skipped, matching dsh-host-plugin-inventory. */
export interface LivePluginEntry {
  entryId: string
  moduleName?: string
  enabled: boolean
  fiberPhase?: string | null
}

/**
 * Push the real plugin inventory out of the process. Returns the number of
 * live (non-group) loader entries reported.
 */
function writePluginInventory(home: string, profileName: string, ctx: Context): number {
  try {
    const loader = (ctx.get as (k: string) => any)?.('loader')
    const entries: LivePluginEntry[] = []
    if (loader && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        if (entry?.options?.group) continue
        entries.push({
          entryId: entry.id,
          moduleName: entry.options?.name,
          enabled: !entry.disabled,
          fiberPhase: entry.fiber === void 0 || entry.fiber === null ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
        })
      }
    }
    const dir = join(home, QAQ_DIR, SHARED_DIR)
    mkdirSync(dir, { recursive: true })
    writeJsonQuiet(join(dir, PLUGIN_INVENTORY_FILE), {
      ts: new Date().toISOString(),
      profile: profileName,
      settled: true,
      count: entries.length,
      entries,
    })
    return entries.length
  } catch { return 0 }
}

/** Cross-package copy of the Cordis Fiber state → phase mapping (const enum). */
const FIBER_PHASE: Record<number, string | null> = {
  0: 'pending',    // FIBER_STATE.PENDING
  1: 'loading',    // LOADING
  2: 'active',     // ACTIVE
  3: 'failed',     // FAILED
  4: null,         // DISPOSED
  5: 'unloading',  // UNLOADING
}

/** Read the profile's bundle list, best-effort. */
function readBundles(home: string, profileName: string): string[] {
  try {
    const pj = JSON.parse(readFileSync(join(home, 'profiles', profileName, 'package.json'), 'utf8'))
    const b = pj?.dsh?.profile?.bundles
    return Array.isArray(b) ? b.map(String) : []
  } catch { return [] }
}

/** Best-effort: derive the active profile name from the working directory if it
 * sits under a profiles/<name> dir. */
function inferProfileName(): string | null {
  const cwd = (process.env.INIT_CWD ?? process.cwd())
  const m = cwd.match(/profiles[\\/]([^\\/]+)/)
  return m ? m[1] : null
}
