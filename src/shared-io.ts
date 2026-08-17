/**
 * qaq-shared — the process-side channel between the `dsh-qaq` plugin (in-process,
 * attached to a live DSH boot, any launcher) and the QAQ CLI guard (out-of-process,
 * the decision authority). It gives the guard everything it needs to watch and
 * repair a DSH that someone *else* launched (desktop / `pnpm dsh web` / a service),
 * without the plugin ever making a decision or touching state.json.
 *
 * Layout under <home>/.qaq/shared/:
 *   plugin-heartbeat.json  — refreshed periodically by the plugin while DSH is up
 *                            (every ~5s, see HEARTBEAT_INTERVAL_MS) so it stays within the
 *                            guard's 15s freshness window: pid, profile, port (when known),
 *                            startedAt, settle state
 *   plugin-state.json      — written by the plugin: the latest in-process health
 *                            observation it can see (failed marker etc., best-effort)
 *   events.jsonl           — append-only, machine-parseable event stream (one JSON
 *                            object per line). Shared by both sides; the CLI guard
 *                            reads it to publish webhooks / surface history.
 *
 * All writes are atomic (temp file + rename) and best-effort (never throw): the
 * guard must never break the very DSH boot it exists to protect. Nothing here
 * writes to state.json or to profile config — rollback is owned by the CLI.
 */
import { mkdirSync, readFileSync, renameSync, appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { qaqDir } from './paths.ts'

/** Subdirectory under .qaq where the process channel lives. */
export const SHARED_DIR_NAME = 'shared'

/** The dsh-qaq plugin heartbeat file name. */
export const HEARTBEAT_FILE = 'plugin-heartbeat.json'
/** The plugin's latest in-process health observation. */
export const PLUGIN_STATE_FILE = 'plugin-state.json'
/** Append-only shared event stream. */
export const EVENTS_FILE = 'events.jsonl'

/** In-process health the plugin can observe without a browser. */
export interface PluginState {
  ts: string
  profile?: string
  /** Whether the host loader tree has settled (the plugin's only reliable signal). */
  settled?: boolean
  /** A failed-boot marker observed in-process, if any. */
  failedMarker?: string | null
  /** Whether the profile config is present and loadable. */
  profileOk?: boolean
  /** The bundle list snapshot at boot (what plugins were in bounds). */
  bundles?: string[]
}

/** Heartbeat written while DSH is running. */
export interface PluginHeartbeat {
  ts: string
  pid: number
  profile?: string
  /** The web port the plugin believes is active, when it can discover it. */
  port?: number
  /** ISO start time of the process (the plugin's best guess). */
  startedAt?: string
  /** Plugin version / protocol rev so the CLI can detect staleness. */
  version: number
}

/** A machine event appended to events.jsonl. */
export interface SharedEvent {
  seq: number
  ts: string
  kind: string
  profile?: string
  data?: Record<string, unknown>
}

/** The default QAQ→plugin channel protocol version. */
export const CHANNEL_VERSION = 1

/** A live plugin entry pushed out by the dsh-qaq plugin (from the Cordis loader). */
export interface LivePluginEntry {
  entryId: string
  moduleName?: string
  enabled: boolean
  fiberPhase?: string | null
}

/** The plugin-inventory file written by the live dsh-qaq plugin. */
export const PLUGIN_INVENTORY_FILE = 'plugin-inventory.json'

/** The live plugin inventory pushed by the in-process plugin. */
export interface PluginInventory {
  ts: string
  profile?: string
  settled?: boolean
  count?: number
  entries?: LivePluginEntry[]
}

/**
 * Read the live plugin inventory straight from the in-process dsh-qaq plugin.
 * This is the AUTHORITATIVE plugin set (the Cordis loader's non-group entries),
 * so the external CLI reflects what DSH actually loaded instead of inferring it
 * from file heuristics. Returns null when the plugin is not up / not reporting.
 */
export function readPluginInventory(home: string, maxAgeMs = 60000): PluginInventory | null {
  return safeReadJson<PluginInventory>(join(sharedDir(home), PLUGIN_INVENTORY_FILE), maxAgeMs)
}

/** Shared channel root under a home. */
export function sharedDir(home: string): string {
  return join(qaqDir(home), SHARED_DIR_NAME)
}

/** Create the shared channel dir (best-effort, never throws). */
export function ensureSharedDir(home: string): string {
  const dir = sharedDir(home)
  try { mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
  return dir
}

function safeReadJson<T>(file: string, maxAgeMs: number): T | null {
  try {
    if (!existsSync(file)) return null
    if (maxAgeMs > 0) {
      const mtime = statSync(file).mtimeMs
      if (Date.now() - mtime > maxAgeMs) return null
    }
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch { return null }
}

/**
 * Atomically write a JSON file: write temp + rename. Best-effort (never throws),
 * so a failure to report never brings down the DSH host or the guard.
 */
export function writeSharedJson(home: string, name: string, value: unknown): void {
  const dir = ensureSharedDir(home)
  const target = join(dir, name)
  const tmp = target + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch { /* best effort */ }
}

/** Read the latest plugin heartbeat, or null when absent/stale. */
/**
 * Read the latest plugin heartbeat, or null when absent/stale.
 * The default 15s window is a contract with the plugin's ~5s refresh interval
 * (HEARTBEAT_INTERVAL_MS in packages/dsh-qaq/src/index.ts): a running DSH keeps
 * its heartbeat within this window, so `qaq watch` can always discover it.
 */
export function readPluginHeartbeat(home: string, maxAgeMs = 15000): PluginHeartbeat | null {
  return safeReadJson<PluginHeartbeat>(join(sharedDir(home), HEARTBEAT_FILE), maxAgeMs)
}

/** Read the latest plugin health state, or null when absent/stale. */
export function readPluginState(home: string, maxAgeMs = 60000): PluginState | null {
  return safeReadJson<PluginState>(join(sharedDir(home), PLUGIN_STATE_FILE), maxAgeMs)
}

/** Whether a heartbeat is recent enough to trust (i.e. DSH is genuinely up). */
export function isHeartbeatFresh(home: string, maxAgeMs = 15000): boolean {
  return readPluginHeartbeat(home, maxAgeMs) !== null
}

/** Aggregated, real connectivity with the in-process dsh-qaq plugin. */
export type PluginConnection = 'connected' | 'connecting' | 'disconnected'

export interface PluginConnectionInfo {
  /** connected: heartbeat+inventory+state all fresh; connecting: some fresh;
   *  disconnected: nothing fresh. */
  state: PluginConnection
  pid?: number
  port?: number
  profile?: string
  settled?: boolean
  pluginCount?: number
}

/**
 * A "real, communicating" connection to the dsh-qaq plugin — not just a shell
 * heartbeat. The plugin continuously pushes heartbeat + state + inventory; we
 * consider it connected only when those channels are all fresh and agree.
 */
export function readPluginConnection(home: string): PluginConnectionInfo {
  const hb = readPluginHeartbeat(home, 15000)
  const inv = readPluginInventory(home, 60000)
  const st = readPluginState(home, 60000)
  const fresh = {
    hb: hb !== null,
    inv: inv !== null,
    st: st !== null,
  }
  let state: PluginConnection = 'disconnected'
  if (fresh.hb && fresh.inv && fresh.st) state = 'connected'
  else if (fresh.hb || fresh.inv || fresh.st) state = 'connecting'
  return {
    state,
    pid: hb?.pid,
    port: hb?.port,
    profile: hb?.profile ?? inv?.profile ?? st?.profile,
    settled: st?.settled,
    pluginCount: inv?.count ?? inv?.entries?.length,
  }
}

/** Monotonic append of a machine event to events.jsonl. Best-effort. */
export function pushEvent(home: string, kind: string, profile: string | undefined, data: Record<string, unknown> = {}): void {
  const dir = ensureSharedDir(home)
  const file = join(dir, EVENTS_FILE)
  const rec: SharedEvent = {
    seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    ts: new Date().toISOString(),
    kind, profile, data,
  }
  try { appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8') } catch { /* best effort */ }
}

/** Read all events newer than a cursor seq (0 = all). Returns [] on any error. */
export function readEvents(home: string, afterSeq = 0): SharedEvent[] {
  try {
    const file = join(sharedDir(home), EVENTS_FILE)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const out: SharedEvent[] = []
    for (const ln of lines) {
      try {
        const e = JSON.parse(ln) as SharedEvent
        if (typeof e.seq === 'number' && e.seq > afterSeq) out.push(e)
      } catch { /* skip bad line */ }
    }
    return out
  } catch { return [] }
}
