/** ============================================================================
 * QAQ TUI — a full-screen, keyboard-navigable dashboard.
 *
 * Pure ANSI + Node raw-mode stdin; zero external deps. Activated from
 * `openConsole` on an interactive TTY, otherwise the CLI falls back to the
 * plain line menu.
 *
 * Layout (top→bottom):
 *   [blue-gradient "QAQ" ASCII banner]
 *   ══  double-line separator ══   (rich horizontal divider)
 *   ◈  <vertical action list>      ← input is a vertical menu; ◈ marks selection
 *   ══  ...
 *   <live status context>
 *   ══  ...
 *   <message line>
 *
 * Input (vertical list, no letter hotkeys):
 *   ↑ / ↓  (or j / k)     move the selection
 *   Enter / Space          run the selected action
 *   1..8                   jump straight to an item
 *   q / Esc / Ctrl+C       quit
 *
 * `out.columns` / `out.rows` drive the size (adaptive). The frame is produced by
 * the pure exported `buildFrame` so the layout is unit-testable without a TTY.
 * ============================================================================= */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readState, profileState, acquireLock, listBackups } from './store.ts'
import { resolveDshHome, profileDir, qaqDir } from './paths.ts'
import { Logger } from './log.ts'
import { preflight, type EnvReport } from './env.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import type { DshSupervisor } from './spawn-dsh.ts'
import { manualBackup, manualRestore, isUsable } from './rollback.ts'
import { installPlugin } from './install-plugin.ts'
import { listPlugins, setPluginEnabled, installPluginModule, uninstallPlugin, type PluginInfo } from './plugin-manager.ts'
import { resolveDshContext, profileBasename, type DshContext } from './dsh-context.ts'
import { watchOnce, resolveWatchTarget, type WatchVerdict } from './watch.ts'
import { isHeartbeatFresh, pushEvent } from './shared-io.ts'
import { verifyPatchInsertApplied, watchClientBundles, watchRestartTriggers, resolveClientBundlePaths } from './hot-update.ts'
import { makeT, type Lang, type T } from './i18n.ts'
import { checkForUpdate, downloadUpdateSource, resolveLocalVersion } from './update.ts'
import { displayWidth, padEnd, truncate } from './width.ts'
import { bannerGradient, hasColor, type RGB } from './color.ts'
import { KeyParser } from './keys.ts'
import type { ConsoleOpts } from './console.ts'

const ESC = '\x1b'
const RESET = ESC + '[0m'
const BOLD = ESC + '[1m'
const DIM = ESC + '[2m'
const RED = ESC + '[31m'
const GRN = ESC + '[32m'
const YEL = ESC + '[33m'
const CYAN = ESC + '[36m'
const CLEAR = ESC + '[2J' + ESC + '[3J' + ESC + '[H'
const HIDE_CURSOR = ESC + '[?25l'
const SHOW_CURSOR = ESC + '[?25h'
const TICK_MS = 1000
/** Poll interval for the continuous sideload (external) guard. Matches the
 *  CLI's `qaq watch` cadence (~15s), comfortable under the plugin heartbeat's
 *  15s freshness window. */
const SIDE_GUARD_INTERVAL_MS = 15000

/** The ASCII "QAQ" wordmark (all rows are equal width). */
/** The ASCII "QAQ" wordmark (all rows are equal width: 71). */
const QAQ_ART = [
  '          -@@@@@@@@@@:             @@@@@.             :@@@@@@@@@@-     ',
  '        @@@@@@@@@@@@@@@%          *@@@@@@           %@@@@@@@@@@@@@@@   ',
  '       @@@@@        @@@@@        :@@@@@@@@         @@@@@        @@@@@  ',
  '      @@@@#          @@@@@       @@@@ *@@@@       @@@@@          #@@@@ ',
  '      @@@@           .@@@@      @@@@   @@@@#      @@@@.           @@@@ ',
  '      @@@@           .@@@@     @@@@=    @@@@:     @@@@            @@@@ ',
  '      @@@@:          *@@@@    #@@@@@@@@@@@@@@     @@@@=          -@@@@ ',
  '      *@@@@    #@@@.-@@@@.   :@@@@@@@@@@@@@@@@    -@@@@.   =@@@:.@@@@- ',
  '       *@@@@@*   #@@@@@@     @@@@         %@@@@    -@@@@@#   +@@@@@@.  ',
  '         %@@@@@@@@@@@@@@@-  @@@@=          @@@@%     *@@@@@@@@@@@@@@@* ',
  '              =**=    @@@@                                =**+    @@@@.',
]
// Blue gradient for the banner, left→right.
const BLUE_GRAD: [RGB, RGB] = [[56, 189, 248], [30, 64, 175]]

interface ActiveGuard { supervisor: DshSupervisor; release: () => void; url: string }

/** Live status of a continuous sideload (external) guard. */
export interface SideGuardStatus {
  /** The watched target URL. */
  url: string
  /** Localized short label for the last probe outcome (healthy / failure / …). */
  last: string
  /** True when the last probe saw a healthy DSH. */
  lastOk: boolean
  /** Poll interval in ms. */
  intervalMs: number
}
/** A live log-view panel. `lines` is the pre-sliced, newest-last window to render. */
export interface LogsView {
  /** Header: the log tab filename (e.g. "error.log"). */
  title: string
  /** Visible (already scrolled) lines, newest last. */
  lines: string[]
  /** Total lines available for the current tab (for an "N of M" indicator). */
  total: number
  /** 0-based scroll offset from the newest (bottom) line. */
  scroll: number
}

/**
 * Compute the visible log window for the TUI log viewer. Pure — deterministic
 * given its inputs, so the fiddly scroll/clamp/slice math is directly testable.
 *
 * @param lines   full tail buffer, newest last
 * @param scroll  0-based offset from the newest (bottom) line; clamped to [0, N]
 * @param maxShown max visible lines (0/negative → no window)
 */
export function computeLogWindow(lines: string[], scroll: number, maxShown: number): { lines: string[]; from: number; to: number } {
  const n = lines.length
  const clamp = Math.max(0, Math.min(scroll, n))
  if (maxShown <= 0 || n === 0) return { lines: [], from: 0, to: 0 }
  let to = n - clamp
  let from = Math.max(0, to - maxShown)
  // A viewport that scrolls entirely above the buffer (scroll >= n) snaps back
  // to the head page so the panel is never empty while lines exist.
  if (to <= 0) { from = 0; to = Math.min(maxShown, n) }
  return { lines: lines.slice(from, to), from, to }
}

export interface FrameInput {
  home: string
  profile: string
  t: T
  lang: Lang
  activeGuard: ActiveGuard | null
  message: string
  report: EnvReport | null
  /** Operating mode (launcher vs sideload vs idle) shown in the status line. */
  mode: TuiMode
  /** When a continuous sideload guard is running, its live status. */
  sideGuard?: SideGuardStatus | null
  /** Real connectivity to the in-process dsh-qaq plugin (all channels fresh). */
  conn: ConnState
  /** When set, the full-screen log viewer replaces the normal status panel. */
  logs: LogsView | null
  /** When set, the plugin-manager panel replaces the log viewer (and the log
   *  viewer is ignored). `rows` are pre-rendered, newest-unimportant ordered;
   *  the selected row is highlighted by index. */
  plugins: PluginsView | null
  /** When set, the backup-management panel replaces the plugin/log panels.
   *  Rows are pre-rendered with section headers; cursor is the flat backup
   *  index (auto then manual). */
  backups?: BackupsView | null
  /** When set, the hot-update panel replaces the plugin/log/backup panels.
   *  `rows` are display-ready toggle lines; `events` the recent activity. */
  hot?: HotView | null
  /** Optional live hot-update status line (rendered under the plugin
   *  connectivity row when non-empty). */
  hotLine?: string | null
  /** Local QAQ version (shown in the header when present). */
  version?: string
  /** When an update is available, its status line (e.g. "- 有新更新 v0.5.0"). */
  updateLine?: string | null
  cols: number
  rows: number
  /** Currently selected menu index (0-based). */
  selected: number
  /** Whether the terminal supports color (banner gradient + colored separators). */
  color: boolean
  /** True on the very first frame so a full clear is sent; false thereafter
   *  to avoid re-clearing on every repaint (which causes flicker). */
  clearFirst: boolean
}

/** The integration mode shown by the dashboard. */
export type TuiMode = 'idle' | 'launcher' | 'sideload'

/** Real dsh-qaq plugin connectivity (heartbeat + inventory + state fresh). */
export type ConnState = 'connected' | 'connecting' | 'disconnected'

/** A rendered plugin-manager panel (rows are display-ready; row 0 is a header). */
export interface PluginsView {
  title: string
  /** Display rows: row 0 = header, rows 1..N = one plugin each. */
  rows: string[]
  /** Index of the selected plugin row (0-based over rows[1..]); -1 when none. */
  cursor: number
  /** Total plugin count across all pages (for the pager header). */
  total: number
  /** Current page (0-based) and total pages. */
  page: number
  pages: number
  /** Optional filter string being applied. */
  filter?: string
  /** Hint line (may change for search / install-path input modes). */
  hint: string
}

/**
 * A rendered backup-management panel. `rows` carry explicit kind metadata so
 * section headers vs selectable backup rows are unambiguous even when a section
 * is empty (a single "(none)" spacer row). `cursor` is the flat index over the
 * selectable backup rows ([auto..., manual...]); -1 when no backups at all.
 */
export interface BackupsView {
  title: string
  rows: { text: string; kind: 'title' | 'section' | 'auto' | 'manual' }[]
  /** Number of selectable auto rows (leading section). */
  autoCount: number
  /** Number of selectable manual rows (trailing section). */
  manualCount: number
  /** Flat index over [auto..., manual...]; -1 when no backups at all. */
  cursor: number
  hint: string
}

/** A rendered hot-update panel (three toggles + recent activity). */
export interface HotView {
  title: string
  /** Display-ready toggle rows (index 0..2 → hotkeys 1..3). */
  rows: string[]
  /** Recent hot-update events (newest first, display-ready). */
  events: string[]
  hint: string
}

function readProfileBundle(home: string, profile: string): string[] {
  try {
    const pj = JSON.parse(readFileSync(join(profileDir(home, profile), 'package.json'), 'utf8'))
    const b = pj?.dsh?.profile?.bundles
    return Array.isArray(b) ? b.map(String) : []
  } catch { return [] }
}

/** Whether the dsh-qaq backup plugin is installed AND enabled for the profile:
 *  listed in `dsh.profile.bundles` and resolvable from the profile node_modules.
 *  Pure — unit-testable without a TTY. */
export function isQaqMounted(home: string, profile: string): boolean {
  if (!readProfileBundle(home, profile).includes('dsh-qaq')) return false
  return existsSync(join(profileDir(home, profile), 'node_modules', 'dsh-qaq', 'package.json'))
}

/** A row: two-space indent, width-truncated. */
function row(content: string, width: number): string {
  return truncate('  ' + content, width)
}

/** The menu item labels in display order (index == action index). The digit
 * hotkeys (1..N) map positionally, so the order here defines the shortcut
 * numbers. The TUI is the all-in-one entry: launch (launcher mode), sideload
 * watch (attach to an external DSH), logs, and the plugin manager. */
function menuLabels(t: T, lang: Lang): string[] {
  const langNow = lang === 'zh' ? '中文' : 'EN'
  return [
    t('tui.menu.launch'),
    t('tui.menu.refresh'),
    t('tui.menu.backup'),
    t('tui.menu.rollback'),
    t('tui.menu.reset'),
    t('tui.menu.mount'),
    t('tui.menu.plugins'),
    t('tui.menu.logs'),
    t('tui.menu.sideload'),
    t('tui.menu.hot'),
    t('tui.menu.update'),
    t('tui.menu.lang') + '  <' + langNow + '>',
    t('tui.menu.quit'),
  ]
}

/** Stable internal ids for each menu item, matching menuLabels order — used to
 * look up the per-item detail line (`tui.menudetail.<id>`) for the selection. */
const MENU_IDS = [
  'launch', 'refresh', 'backup', 'rollback', 'reset',
  'mount', 'plugins', 'logs', 'sideload', 'hot', 'update', 'lang', 'quit',
] as const

/** Map a one-shot `watchOnce` verdict to a short localized outcome label for the
 *  continuous sideload guard's status line. Pure — easily unit-tested. */
export function diagnoseVerdict(v: WatchVerdict, t: T): string {
  if (v.ok) return t('tui.sideload.ok')
  if (v.rolledBack) return t('tui.sideload.rolledBack')
  if (v.kind === 'host' || v.kind === 'ui') return t('tui.sideload.failed', { kind: v.kind })
  return v.error ?? t('tui.sideload.unknown')
}

/** Log tabs available in the TUI log viewer (1..4 hotkeys). */
export const LOG_TABS = ['error', 'access', 'host', 'qaq'] as const
export type LogTab = (typeof LOG_TABS)[number]
export const LOG_HEADERS: Record<LogTab, string> = {
  error: 'error.log',
  access: 'access.log',
  host: 'host.log',
  qaq: 'qaq.log',
}

/** Render the vertical menu list; `◈` marks the selected row. In compact mode
 * (small terminal height) the marker column collapses to keep rows narrow. */
function menuLines(labels: string[], selected: number, width: number, compact: boolean): string[] {
  const pre = compact ? '' : '   '
  return labels.map((label, i) => {
    const mark = i === selected ? CYAN + (compact ? '>' : '◈ ') + RESET + BOLD : pre
    return row(mark + label, width)
  })
}

/** A rich double-line horizontal separator (`══`), with bevel-ish ends. */
function dblRule(width: number): string {
  return truncate('═'.repeat(Math.max(2, width)), width)
}

/** Build one frame of the dashboard. Pure — deterministic given its inputs. */
export function buildFrame(f: FrameInput): string {
  const W = Math.max(74, f.cols)
  const rows = Math.max(12, f.rows || 24)

  const state = readState(f.home)
  const p = profileState(state, f.profile)
  const mounted = readProfileBundle(f.home, f.profile).includes('dsh-qaq')
  const labels = menuLabels(f.t, f.lang)

  const L: string[] = []
  // The frame must fit ONE screen of `rows` exactly (real-time terminal size).
  // The banner is a "nice to have": show it only when there is room; on small
  // heights use a one-line compact header so nothing is occluded.
  const compact = rows < 16
  const ver = f.version ? ' v' + f.version : ''
  if (compact) {
    L.push(row(BOLD + 'QAQ' + ver + ' · ' + f.t('tui.langLabel', { l: f.lang === 'zh' ? '中文' : 'EN' }) + RESET, W))
  } else {
    if (f.color) {
      for (const l of bannerGradient(QAQ_ART, BLUE_GRAD[0], BLUE_GRAD[1])) L.push('  ' + l)
    } else {
      for (const l of QAQ_ART) L.push('  ' + l)
    }
    L.push(row(DIM + f.profile + ' ·' + ver + ' · ' + f.t('tui.langLabel', { l: f.lang === 'zh' ? '中文' : 'EN' }) + RESET, W))
  }
  L.push(dblRule(W))

  // Vertical menu list (primary input) + the selected item's detail line.
  L.push(...menuLines(labels, f.selected, W, compact))
  const detailKey = 'tui.menudetail.' + MENU_IDS[f.selected]
  L.push(row(DIM + '· ' + f.t(detailKey) + RESET, W))
  L.push(dblRule(W))

  // Live status context (only on roomy screens; a tiny height keeps the core).
  const status = f.activeGuard
    ? GRN + '● ' + f.t('console.launch.monitoring') + '  ' + f.activeGuard.url + RESET
    : DIM + '○ ' + f.t('tui.guard.idle') + RESET
  L.push(row(status, W))
  const modeKey = f.mode === 'launcher' ? 'tui.mode.launcher' : f.mode === 'sideload' ? 'tui.mode.sideload' : 'tui.mode.idle'
  const modeColor = f.mode === 'launcher' ? GRN : f.mode === 'sideload' ? CYAN : DIM
  L.push(row(modeColor + '◆ ' + f.t(modeKey) + RESET, W))
  // Continuous sideload guard status (active watch on an external DSH).
  if (f.sideGuard) {
    const sgColor = f.sideGuard.lastOk ? CYAN : YEL
    const sg = f.t('tui.sideload.active') + '  ' + f.sideGuard.url + '  ·  ' + f.sideGuard.last
    L.push(row(sgColor + '▶ ' + sg + RESET, W))
  }
  // Real dsh-qaq plugin connectivity (⬤ green=connected, yellow=connecting, red=off).
  const connKey = f.conn === 'connected' ? 'tui.dsh.conn.connected' : f.conn === 'connecting' ? 'tui.dsh.conn.connecting' : 'tui.dsh.conn.disconnected'
  const connColor = f.conn === 'connected' ? GRN : f.conn === 'connecting' ? YEL : RED
  L.push(row(connColor + '⬤ ' + f.t(connKey) + RESET, W))
  // Hot-update live status line (watchers / auto-restart toggles).
  if (f.hotLine) {
    L.push(row(CYAN + '♨ ' + f.hotLine + RESET, W))
  }
  // Version-update notice (Beta): "- 有新更新 vX.X.X" when a newer release exists.
  if (f.updateLine) {
    L.push(row(YEL + '- ' + f.updateLine + RESET, W))
  }
  if (!compact) {
    const labelW = 12
    const lastFail = p.lastFailure
      ? (p.lastFailure.kind === 'host' ? f.t('tui.state.host') : f.t('tui.state.ui')) + ' @ ' + p.lastFailure.ts
      : f.t('tui.fail.none')
    L.push(row(BOLD + padEnd(f.t('tui.state.host'), labelW) + RESET + ' ' + String(p.hostFailures ?? 0) + '   ' + BOLD + padEnd(f.t('tui.state.ui'), labelW) + RESET + ' ' + String(p.uiFailures ?? 0), W))
    L.push(row(BOLD + padEnd(f.t('tui.state.lastSuccess'), labelW) + RESET + ' ' + (p.lastSuccess || '-') + '   ' + BOLD + padEnd(f.t('tui.state.lastFailure'), labelW) + RESET + ' ' + lastFail, W))
    L.push(row(BOLD + padEnd(f.t('tui.state.lastGood'), labelW) + RESET + ' ' + (p.lastGoodSnapshot ?? f.t('console.state.noSnapshot')) + '   ' + BOLD + padEnd(f.t('tui.state.rolledBack'), labelW) + RESET + ' ' + (p.rolledBackAt || '-'), W))
  }
  const pluginState = mounted
    ? GRN + f.t('tui.plugin.mounted') + '  dsh-qaq' + RESET
    : YEL + f.t('tui.plugin.notMounted') + RESET
  L.push(row(BOLD + padEnd(f.t('tui.plugin.section'), compact ? 8 : 12) + RESET + ' ' + pluginState, W))
  L.push(dblRule(W))

  // === Plugin-manager panel (takes priority over logs/message). ===
  let hint = DIM + '↑/↓ 选择 · Enter 执行 · q 退出' + RESET
  if (f.plugins) {
    const pager = f.plugins.pages > 1
      ? '  [' + (f.plugins.page + 1) + '/' + f.plugins.pages + ' 页]'
      : ''
    const filterSuffix = f.plugins.filter ? '  过滤: ' + f.plugins.filter : ''
    const header = BOLD + '── ' + f.plugins.title + ' · 共 ' + f.plugins.total + ' 个' + pager + filterSuffix + ' ──' + RESET
    L.push(row(header, W))
    L.push(dblRule(W))
    for (let i = 0; i < f.plugins.rows.length; i++) {
      const r = f.plugins.rows[i]
      if (i === 0) L.push(row(BOLD + r + RESET, W))
      else {
        const mark = i - 1 === f.plugins.cursor ? (CYAN + '◈ ' + RESET) : '   '
        L.push(row(mark + r, W))
      }
    }
    // A closing rule marks the bottom of the plugin list.
    L.push(dblRule(W))
    hint = DIM + f.plugins.hint + RESET
  } else if (f.backups) {
    // Backup-management panel. rows carry {kind} so section headers are
    // unambiguous; the flat cursor maps onto consecutive 'auto'/'manual' rows.
    const b = f.backups
    const header = BOLD + '── ' + b.title + ' ──' + RESET
    L.push(row(header, W))
    L.push(dblRule(W))
    let flat = 0 // flat backup index for the current selectable row
    for (const r of b.rows) {
      if (r.kind === 'title' || r.kind === 'section') {
        L.push(row(DIM + r.text + RESET, W))
      } else {
        const mark = flat === b.cursor ? (CYAN + '◈ ' + RESET) : '   '
        L.push(row(mark + r.text, W))
        flat++
      }
    }
    L.push(dblRule(W))
    hint = DIM + b.hint + RESET
  } else if (f.logs) {
    const header = BOLD + '── ' + f.logs.title + ' ──  '
      + (f.logs.total > 0 ? (f.logs.total - f.logs.scroll) + ' / ' + f.logs.total : '0') + RESET
    L.push(row(header, W))
    L.push(dblRule(W))
    if (f.logs.lines.length === 0) {
      L.push(row(DIM + (f.t('console.logs.none')) + RESET, W))
    } else {
      for (const ln of f.logs.lines) L.push(row(DIM + ln + RESET, W))
    }
    hint = DIM + '1-4 切换日志 · ↑/↓ 滚动 · q/Esc 返回' + RESET
  } else if (f.hot) {
    // Hot-update panel: three toggle rows + recent events.
    const header = BOLD + '── ' + f.hot.title + ' ──' + RESET
    L.push(row(header, W))
    L.push(dblRule(W))
    for (const r of f.hot.rows) L.push(row(r, W))
    L.push(dblRule(W))
    const ev = f.hot.events.length === 0 ? [DIM + f.t('tui.hot.events.none') + RESET] : f.hot.events.map((e) => DIM + e + RESET)
    for (const e of ev) L.push(row(e, W))
    L.push(dblRule(W))
    hint = DIM + f.hot.hint + RESET
  } else {
    // Message line
    L.push(row(DIM + (f.message || '') + RESET, W))
  }

  // Fit EXACTLY within the visible height (rectangular page = terminal size).
  const bodyBudget = Math.max(10, Math.max(12, rows) - 1)
  if (L.length > bodyBudget) L.splice(0, L.length - bodyBudget)

  // Bottom hint line
  const padAll = (strs: string[]): string[] => strs.map(s => padEnd(s, W))
  const bodyArr = padAll(L)
  const hintRow = padEnd(row(hint, W), W)
  const prefix = (f.clearFirst ? CLEAR : '') + ESC + '[H' + HIDE_CURSOR
  return prefix + bodyArr.join('\n') + '\n' + hintRow
}

/** Run the full-screen TUI until quit. Returns true when it ran; false when the
 * environment isn't an interactive TTY (caller then falls back to the plain menu). */
export async function runTui(opts: ConsoleOpts, profile = 'web'): Promise<boolean> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false

  let lang: Lang = opts.lang ?? 'zh'
  const home = resolveDshHome()
  const log = new Logger(home)
  const stdin = process.stdin
  const out = process.stdout
  const colorOn = hasColor(out)

  let t: T = makeT(lang)
  const setLang = (l: Lang): void => { lang = l; t = makeT(l) }

  let activeGuard: ActiveGuard | null = null
  /** Running continuous sideload guard (external DSH). timer is the interval id
   *  while active; null once stopped (the url/last stay for one repaint). */
  let sideGuard: { timer: ReturnType<typeof setInterval> | null; busy: boolean; url: string; last: string; lastOk: boolean } | null = null
  let message = t('tui.msg.placeholder')
  // Version-update check state (Beta). `latest` is the remote version found by
  // the last check; `available` means latest > local — the status line then
  // shows "- 有新更新 vX.X.X" and pressing the menu item again confirms the
  // update (downloads the master source archive).
  const version = resolveLocalVersion()
  let updateState: { latest: string | null; available: boolean } | null = null
  let report: EnvReport | null = null
  let selected = 0

  // Which sub-screen is active: the main menu, the log viewer, the plugin
  // manager, the backup manager, or the hot-update panel (the TUI is the
  // all-in-one entry for launch, watch, logs, backups, plugins, hot update).
  type TuiView = 'menu' | 'logs' | 'plugins' | 'backups' | 'hot'
  let view: TuiView = 'menu'

  // === Backup-manager state. ===
  let backupCursor = 0 // flat index over [auto..., manual...]
  /** The selectable backup dirs, newest-first, for the current profile. */
  let backupAuto: string[] = []
  let backupManual: string[] = []

  // === Log viewer state. ===
  let logTab: LogTab = 'error'
  let logLines: string[] = [] // newest last, refreshed each paint
  let logScroll = 0 // offset from the newest (bottom) line

  // === Plugin-manager state. ===
  let pluginCursor = 0 // index into the current visible page
  let pluginPage = 0 // 0-based page (left/right keys page through)
  let pluginFilter = '' // case-insensitive name filter (search)
  type PInput = 'none' | 'filter' | 'path' | 'scan'
  let pluginInput: PInput = 'none' // active inline input mode
  let pluginInputBuf = '' // buffered text for the active input mode
  let pluginScan: { name: string; dir: string; description?: string }[] = [] // scan-install candidates
  let pluginScanCursor = 0
  // After a mutation (enable/disable/install/uninstall) the on-disk profile is
  // the truth; the live dsh-qaq inventory may still report the OLD state until
  // DSH reloads. Flip this so the list reflects the real file state immediately.
  let pluginUseFileState = false

  // === Hot-update state (three independent channels). ===
  /** Channel 1: running client-bundle watch disposer, or null. */
  let hotWatch: { dispose: () => void; count: number } | null = null
  /** Channel 3: auto-restart toggles (pseudo-update). */
  const autoRestart = { bundles: false, dist: false }
  /** Recent hot-update activity (newest first, capped). */
  const hotEvents: string[] = []
  const pushHotEvent = (text: string): void => {
    hotEvents.unshift(text)
    if (hotEvents.length > 4) hotEvents.pop()
  }
  /** Channel 3's restart-trigger watcher disposer, or null. */
  let restartWatch: { dispose: () => void } | null = null
  // Paste/drag-drop: the chunk is already UTF-8-decoded by Node, so we just strip
  // bracketed-paste markers (\x1b[200~/201~) and accept printable unicode.
  const resetInputBuf = (): void => { pluginInputBuf = '' }
  // The REAL DeepSeek Harness installation being managed (home + profile +
  // checkout). Resolved fresh so the process/heartbeat status stays live.
  const dshCtx = (): DshContext => resolveDshContext({ profile, cwd: opts.cwd })
  const logDir = (): string => join(qaqDir(home), 'log')
  /** Read the tail of one log file (newest last). Best-effort. */
  const readLogTail = (file: string, maxLines: number): string[] => {
    try {
      const raw = readFileSync(join(logDir(), file), 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      return lines.slice(Math.max(0, lines.length - maxLines))
    } catch { return [] }
  }
  /** Reload current tab's tail with a generous window so scrolling has headroom. */
  const reloadLogs = (): void => {
    logLines = readLogTail(LOG_HEADERS[logTab], 500)
    logScroll = Math.min(logScroll, Math.max(0, logLines.length))
  }
  const enterLogs = (tab: LogTab): void => {
    logTab = tab
    logScroll = 0
    reloadLogs()
    view = 'logs'
  }

  /** The current operating mode: launcher (we own a child) / sideload (a
   *  continuous sideload guard runs, or an external DSH is up via heartbeat) /
   *  idle. */
  const detectMode = (): TuiMode => {
    if (activeGuard) return 'launcher'
    if (sideGuard && sideGuard.timer) return 'sideload'
    return isHeartbeatFresh(home) ? 'sideload' : 'idle'
  }
  const refreshReport = (): void => { void preflight({ cwd: opts.cwd, port: opts.port, lang }).then((r) => { report = r }).catch(() => {}) }
  refreshReport()

  /** Refresh the backup lists for this profile (auto set + manual set). */
  const refreshBackups = (): void => {
    backupAuto = listBackups(home, 'auto')
    backupManual = listBackups(home, 'manual')
    const total = backupAuto.length + backupManual.length
    if (backupCursor >= total && total > 0) backupCursor = total - 1
    if (total === 0) backupCursor = 0
  }
  /** Enter the backup-management sub-screen. */
  const enterBackups = (): void => {
    refreshBackups()
    backupCursor = 0
    view = 'backups'
  }
  /** The flat backup dir at `cursor` (auto then manual), or null. */
  const backupAt = (cursor: number): string | null => {
    if (cursor < backupAuto.length) return backupAuto[cursor]
    const mi = cursor - backupAuto.length
    return mi < backupManual.length ? backupManual[mi] : null
  }

  /** Render the backup-management panel (rows with section headers). */
  function renderBackupsView(): BackupsView {
    const rows: { text: string; kind: 'title' | 'section' | 'auto' | 'manual' }[] = []
    rows.push({ text: t('tui.backups.title', { profile }), kind: 'title' })
    // Auto section.
    rows.push({ text: t('tui.backups.autoHeader', { n: String(backupAuto.length) }), kind: 'section' })
    if (backupAuto.length === 0) {
      rows.push({ text: '  ' + t('tui.backups.none'), kind: 'section' })
    } else {
      for (const dir of backupAuto) rows.push({ text: formatBackupRow(dir), kind: 'auto' })
    }
    // Manual section.
    rows.push({ text: t('tui.backups.manualHeader', { n: String(backupManual.length) }), kind: 'section' })
    if (backupManual.length === 0) {
      rows.push({ text: '  ' + t('tui.backups.none'), kind: 'section' })
    } else {
      for (const dir of backupManual) rows.push({ text: formatBackupRow(dir), kind: 'manual' })
    }
    return {
      title: t('tui.backups.title', { profile }),
      rows,
      autoCount: backupAuto.length,
      manualCount: backupManual.length,
      cursor: backupCursor,
      hint: t('tui.backups.hint'),
    }
  }
  /** A backup row: the trailing timestamped dir name + the ISO ts from its manifest. */
  function formatBackupRow(dir: string): string {
    const name = basename(dir)
    let tsText = ''
    try {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { ts?: string }
      if (m.ts) tsText = '  ' + m.ts
    } catch { /* keep just the dir name */ }
    return name + tsText
  }

  let firstRender = true
  const paint = (): void => {
    const cols = out.columns || 100
    const rows = out.rows || 24
    const mode: TuiMode = detectMode()
    // Build the sub-screen panel (pre-rendered by the caller).
    let logs: LogsView | null = null
    let plugins: PluginsView | null = null
    let backups: BackupsView | null = null
    let hot: HotView | null = null
    if (view === 'logs') {
      reloadLogs()
      const maxBody = Math.max(10, Math.max(12, rows) - 3)
      const maxShown = Math.max(4, maxBody - 6)
      const win = computeLogWindow(logLines, logScroll, maxShown)
      logs = { title: LOG_HEADERS[logTab], lines: win.lines, total: logLines.length, scroll: Math.min(logScroll, Math.max(0, logLines.length)) }
    } else if (view === 'plugins') {
      plugins = renderPluginsView(Math.max(12, rows))
    } else if (view === 'backups') {
      refreshBackups()
      backups = renderBackupsView()
    } else if (view === 'hot') {
      hot = renderHotView()
    }
    // Real dsh-qaq connectivity (all shared channels fresh).
    const conn: ConnState = dshCtx().connection.state
    const sgStatus = sideGuard && sideGuard.timer
      ? { url: sideGuard.url, last: sideGuard.last, lastOk: sideGuard.lastOk, intervalMs: SIDE_GUARD_INTERVAL_MS }
      : undefined
    out.write(buildFrame({ home, profile, t, lang, activeGuard, message, report, mode, conn, sideGuard: sgStatus, logs, plugins, backups, hot, hotLine: hotStatusLine(), version, updateLine: updateState?.available && updateState.latest ? t('tui.update.hasNew', { version: updateState.latest }) : null, cols, rows, selected, color: colorOn, clearFirst: firstRender }))
    firstRender = false
  }

  /** Auto-mount the dsh-qaq backup plugin on dashboard open (idempotent: an
   *  installed+enabled plugin is left untouched). Best-effort — a failure only
   *  logs a warning and shows the plugin's own message, never blocks the TUI. */
  function ensureQaqMounted(): void {
    if (isQaqMounted(home, profile)) return
    try {
      const r = installPlugin(home, profile, log, lang)
      if (r.ok) {
        pushEvent(home, 'qaq-auto-mount', profile, { ok: true, mounted: r.mounted })
        log.access('auto-mounted dsh-qaq plugin (dashboard open)', { profile, action: 'auto-mount' })
        message = r.message
      } else {
        log.warn('auto-mount dsh-qaq failed: ' + r.message)
      }
    } catch (err) {
      log.warn('auto-mount dsh-qaq errored: ' + String(err instanceof Error ? err.message : err))
    }
  }
  // Run after the first frame so the dashboard renders instantly; unref'd so it
  // can never keep the process alive on an immediate quit.
  const autoMountTimer = setTimeout(() => { ensureQaqMounted(); paint() }, 150)
  autoMountTimer.unref?.()

  /** Page size: plugin rows that fit in the terminal. Shared by render + input. */
  function pluginPerPage(rows: number): number {
    return Math.max(1, (Math.max(12, rows) - 11))
  }

  /** After a mutation the on-disk profile is the truth; skip the (possibly stale)
   *  live inventory so the change shows immediately. */
  function liveEntriesFor(ctx: DshContext): NonNullable<typeof ctx.liveInventory>['entries'] {
    return pluginUseFileState ? undefined : ctx.liveInventory?.entries
  }

  /** The filtered plugin list (search applied). */
  function currentFiltered(ctx: DshContext): PluginInfo[] {
    return listPlugins({ profileDir: ctx.profileDir, profile, checkout: ctx.checkout, poolDir: ctx.poolDir, liveEntries: liveEntriesFor(ctx) })
      .filter((p) => !pluginFilter || shortPluginName(p.name).toLowerCase().includes(pluginFilter.toLowerCase()))
  }

  /** The plugin currently under the cursor, accounting for page offset + search. */
  function currentTarget(ctx: DshContext, rows: number): PluginInfo | undefined {
    const filtered = currentFiltered(ctx)
    const perPage = pluginPerPage(rows)
    const idx = pluginPage * perPage + pluginCursor
    return idx < filtered.length ? filtered[idx] : undefined
  }

  /** Render the plugin-manager panel from the current on-disk real DSH state,
   *  paginated + filtered, sized to `rows`. Pure given the closure state. */
  function renderPluginsView(rows: number): PluginsView {
    const ctx = dshCtx()
    const filtered = listPlugins({ profileDir: ctx.profileDir, profile, checkout: ctx.checkout, poolDir: ctx.poolDir, liveEntries: liveEntriesFor(ctx) })
      .filter((p) => !pluginFilter || shortPluginName(p.name).toLowerCase().includes(pluginFilter.toLowerCase()))

    // Page size: how many plugin rows fit given the terminal height.
    const perPage = pluginPerPage(rows)
    const pages = Math.max(1, Math.ceil(filtered.length / perPage))
    if (pluginPage >= pages) pluginPage = pages - 1
    if (pluginPage < 0) pluginPage = 0
    const start = pluginPage * perPage
    const slice = filtered.slice(start, start + perPage)

    const rowsOut: string[] = [t('tui.plugins.header')]
    // NOTE: rowsOut[1..] MUST be exactly the plugins (0 rows selectable). A
    // status/detail row here would offset the ◈ cursor from the action target —
    // that was the bug where "precise-cache" selected but disable hit "qaq".
    if (slice.length === 0) {
      rowsOut.push(t('pluginMgr.empty'))
    } else {
      for (const info of slice) rowsOut.push(pluginColoredRow(t, info))
    }

    // Process/checkout status goes in the TITLE (non-selectable), not as a row.
    // Real connectivity to the in-process dsh-qaq plugin (all channels fresh).
    const conn = ctx.connection
    const connColor = conn.state === 'connected' ? GRN : conn.state === 'connecting' ? YEL : RED
    const connLabel = conn.state === 'connected' ? t('tui.dsh.conn.connected')
      : conn.state === 'connecting' ? t('tui.dsh.conn.connecting') : t('tui.dsh.conn.disconnected')
    const connSeg = connColor + '⬤ ' + connLabel + RESET
      + (conn.pid ? ' pid=' + conn.pid : '')
      + (conn.port ? ' port=' + conn.port : '')
      + (typeof conn.pluginCount === 'number' ? ' · ' + t('pluginMgr.count', { n: String(conn.pluginCount) }) : '')
      // Independent of dsh-qaq: even offline this manager works via local file
      // discovery (bundles + patch inserts + node_modules + checkout packages).
      + (ctx.liveInventory ? '' : t('tui.plugins.local'))
    const title = t('tui.plugins.title', { profile }) + '  ' + connSeg
    // Hint reflects the active inline input mode.
    let hint = t('tui.plugins.hint')
    if (pluginInput === 'scan') {
      // Scan-pick mode: list the discovered plugin candidates for selection.
      const scanW = Math.max(74, out.columns || 100)
      const scanRows: string[] = [t('tui.plugins.scanTitle')]
      if (pluginScan.length === 0) scanRows.push(t('pluginMgr.empty'))
      else for (let i = 0; i < pluginScan.length; i++) {
        const c = pluginScan[i]
        const mark = i === pluginScanCursor ? CYAN + '◈ ' + RESET + BOLD : '   '
        scanRows.push(row(mark + c.name + (c.description ? DIM + '  ·  ' + c.description + RESET : ''), scanW))
      }
      return {
        title: t('tui.plugins.scanTitle') + ' · ' + pluginScan.length,
        rows: scanRows,
        cursor: pluginScanCursor,
        total: pluginScan.length,
        page: 0,
        pages: 1,
        hint: t('tui.plugins.scanHint'),
      }
    }
    if (pluginInput === 'filter') hint = '➤ 搜索: ' + (pluginInputBuf || '…') + '    回车确认 · Esc 取消'
    else if (pluginInput === 'path') hint = '➤ 安装插件路径: ' + (pluginInputBuf || '…') + '    回车确认 · Esc 取消'
    return { title, rows: rowsOut, cursor: (slice.length ? pluginCursor % slice.length : -1), total: filtered.length, page: pluginPage, pages, filter: pluginFilter || undefined, hint }
  }

  /**
   * Short display name for a plugin: strip the `@deepseek-ai/dsh-` prefix (and
   * any unscoped `dsh-` prefix), matching how the web UI labels plugins
   * (`@deepseek-ai/dsh-pwsh-sandbox` → `pwsh-sandbox`). Non-dsh modules are
   * given back as-is.
   */
  function shortPluginName(name: string): string {
    let s = name
    if (s.startsWith('@deepseek-ai/dsh-')) s = s.slice('@deepseek-ai/dsh-'.length)
    else if (s.startsWith('dsh-')) s = s.slice('dsh-'.length)
    return s || name
  }

  /**
   * A plugin row: the short display name (the part after `dsh-`, e.g.
   * `@deepseek-ai/dsh-pwsh-sandbox` → `pwsh-sandbox`), coloured by state:
   * enabled=green, disabled=red, uninstalled=dim. No check/cross glyphs.
   */
  function pluginColoredRow(_t: T, info: PluginInfo): string {
    const label = shortPluginName(info.name)
    if (info.enabled) return GRN + label + RESET
    if (info.installed) return RED + label + RESET
    return DIM + label + RESET
  }

  /** Keep the plugin cursor within the current page (or 0 when empty). */
  function clampPluginCursor(next: number): number {
    const ctx = dshCtx()
    const filtered = currentFiltered(ctx)
    const perPage = pluginPerPage(Math.max(12, out.rows || 24))
    const pageLen = Math.max(1, Math.min(perPage, filtered.length - pluginPage * perPage))
    pluginCursor = ((next % pageLen) + pageLen) % pageLen
    return pluginCursor
  }

  /** Scan a root directory for installable plugin packages (bounded depth). */
  function scanPluginDirs(root: string, depth = 0, out: { name: string; dir: string; description?: string }[] = []): { name: string; dir: string; description?: string }[] {
    if (depth > 3) return out
    let text: string
    try { text = readFileSync(join(root, 'package.json'), 'utf8') } catch { text = '' }
    if (text) {
      let j: { name?: string; description?: string; dsh?: { bundle?: { patch?: string }; client?: unknown } }
      try { j = JSON.parse(text) } catch { return out }
      // A "plugin" is any DSH-aware package: a bundle layer (dsh.bundle) OR a
      // client-inject plugin (dsh.client) — e.g. dsh-precise-cache. Dependencies
      // without any `dsh` section (e.g. cosmokit) are not plugins.
      if (j?.dsh?.bundle?.patch || j?.dsh?.client) out.push({ name: j.name || basename(root), dir: root, description: j.description })
      return out // a package dir: don't recurse into it
    }
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
    const children = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    for (const ent of children) scanPluginDirs(join(root, ent.name), depth + 1, out)
    return out
  }

  /**
   * Install a plugin from an explicit path. If `path` is itself a plugin
   * package (has package.json with dsh.bundle.patch), install it directly. If it
   * is a directory containing plugin packages, scan it and populate the scan
   * picker (scan mode) so the user chooses which one to install.
   */
  function installFromPath(path: string): string {
    const ctx = dshCtx()
    if (!path.trim()) return t('tui.plugins.pathEmpty')
    // Direct package path?
    let name = ''
    try { name = (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: string }).name || '' } catch { name = '' }
    if (name) {
      // An explicit full path to one plugin package: install it directly.
      const r = installPluginModule({ profileDir: ctx.profileDir, profile, name, source: path, poolDir: ctx.poolDir }, new Logger(home), lang)
      pluginUseFileState = true
      return r.message
    }
    // Otherwise treat it as a scan root: ALWAYS list what was found and let the
    // user pick. Never auto-install from a scan (even a single hit) — the user
    // must select a plugin and confirm.
    const found = scanPluginDirs(path)
    if (found.length === 0) return t('tui.plugins.scanNone', { path })
    pluginScan = found
    pluginScanCursor = 0
    pluginInput = 'scan'
    pluginInputBuf = ''
    return t('tui.plugins.scanFound', { n: String(found.length), path })
  }

  const menuCount = (): number => menuLabels(t, lang).length

  /** Execute the action at `idx`. Returns true when it quit the TUI. */
  async function runAction(idx: number): Promise<boolean> {
    switch (idx) {
      case 0: await launchGuard(); return false
      case 1: paint(); return false
      case 2: manualBackup(home, profile, log); message = t('console.backup.done'); return false
      case 3: enterBackups(); return false
      case 4: resetCounters(); return false
      case 5: { const res = installPlugin(home, profile, new Logger(home), lang); message = res.message; refreshReport(); return false }
      case 6: view = 'plugins'; pluginCursor = 0; pluginPage = 0; pluginFilter = ''; pluginInput = 'none'; pluginInputBuf = ''; paint(); return false
      case 7: enterLogs('error'); paint(); return false
      case 8: view = 'menu'; { const r = await toggleSideGuard(); if (r !== undefined) message = r; } paint(); return false
      case 9: view = 'hot'; paint(); return false
      case 10: await runUpdateFlow(); return false
      case 11: setLang(lang === 'zh' ? 'en' : 'zh'); refreshReport(); return false
      case 12: return true // quit
      default: return false
    }
  }

  /** "检测更新 (Beta)" — two-step flow: the first press checks GitHub for a
   *  newer version; when one is found the status line shows "- 有新更新 vX.X.X"
   *  and a second press confirms the update (downloads the master source
   *  archive into ~/.dsh/.qaq/update/ and prints the upgrade steps). */
  async function runUpdateFlow(): Promise<void> {
    if (updateState?.available && updateState.latest) {
      // Confirmed update: download the source archive.
      message = t('tui.update.downloading', { version: updateState.latest })
      paint()
      const res = await downloadUpdateSource({ version: updateState.latest, dir: join(qaqDir(home), 'update') })
      if (res.ok && res.path) {
        message = t('tui.update.downloaded', { path: res.path })
        log.access('update source downloaded to ' + res.path, { action: 'update-download', version: updateState.latest, ok: true })
      } else {
        message = t('tui.update.downloadFailed', { error: res.error ?? '?' })
        log.access('update source download failed: ' + (res.error ?? '?'), { action: 'update-download', ok: false })
      }
      return
    }
    message = t('tui.update.checking')
    paint()
    const r = await checkForUpdate()
    if (!r.ok) {
      updateState = null
      message = t('tui.update.failed', { error: r.error ?? '?' })
      return
    }
    updateState = { latest: r.latest, available: r.updateAvailable }
    message = r.updateAvailable
      ? t('tui.update.available', { current: r.current, latest: r.latest ?? '?' })
      : t('tui.update.latest', { version: r.current })
  }

  /**
   * Toggle the continuous sideload guard. When off: resolve the external DSH
   * target once (explicit --port, else the dsh-qaq heartbeat), then keep polling
   * `watchOnce` every SIDE_GUARD_INTERVAL_MS so a crash / red screen is counted
   * and — at threshold — rolled back, exactly like `qaq watch`. When on: stop it.
   * Rollback is CLI-owned here (autoConfirm, no prompt) because this TUI is not
   * the supervised child's parent; the plugin only reports.
   */
  async function toggleSideGuard(): Promise<string | undefined> {
    if (activeGuard) return t('console.launch.alreadyRunning')
    if (sideGuard && sideGuard.timer) {
      clearInterval(sideGuard.timer)
      sideGuard.timer = null
      const url = sideGuard.url
      sideGuard = null
      return t('tui.sideload.stopped', { url })
    }
    // Resolve the target NOW and pin its port into the poll loop. This keeps
    // watching even after a crash makes the plugin heartbeat go stale (the port
    // stays reachable-checkable), so a foreign DSH is repaired after it dies.
    const slog = new Logger(home)
    const target = resolveWatchTarget({ home, profile, attachPort: opts.port }, slog)
    if (!target) return t('tui.sideload.notFound')
    const port = target.port
    const url = 'http://127.0.0.1:' + port
    sideGuard = { timer: null, busy: false, url, last: t('tui.sideload.starting'), lastOk: false }

    const tick = async (): Promise<void> => {
      if (!sideGuard || sideGuard.busy) return
      sideGuard.busy = true
      try {
        const v = await watchOnce({ home, profile, attachPort: port, threshold: opts.threshold, autoConfirm: true, uiTimeoutMs: opts.uiTimeoutMs }, slog)
        if (!sideGuard) return
        sideGuard.lastOk = v.ok
        sideGuard.last = diagnoseVerdict(v, t)
      } catch (err) {
        if (sideGuard) { sideGuard.last = String(err instanceof Error ? err.message : err); sideGuard.lastOk = false }
      } finally {
        if (sideGuard) sideGuard.busy = false
        paint()
      }
    }
    void tick()
    sideGuard.timer = setInterval(() => { void tick() }, SIDE_GUARD_INTERVAL_MS)
    return t('tui.sideload.started', { url, sec: String(Math.round(SIDE_GUARD_INTERVAL_MS / 1000)) })
  }

  function resetCounters(): void {
    const s = readState(home); const pr = profileState(s, profile)
    pr.hostFailures = 0; pr.uiFailures = 0; delete pr.lastFailure
    void import('./store.ts').then((m) => { m.writeState(home, s) })
    new Logger(home).access('reset counters via TUI', { profile, action: 'reset' })
    message = t('console.reset.done')
  }

  /** Render the hot-update panel (three toggles + recent activity). */
  function renderHotView(): HotView {
    const on = (b: boolean): string => b ? GRN + t('tui.hot.on') + RESET : DIM + t('tui.hot.off') + RESET
    return {
      title: t('tui.hot.title', { profile }),
      rows: [
        t('tui.hot.row.watch', { state: on(hotWatch !== null) }),
        t('tui.hot.row.bundles', { state: on(autoRestart.bundles) }),
        t('tui.hot.row.dist', { state: on(autoRestart.dist) }),
      ],
      events: hotEvents.slice(0, 4),
      hint: t('tui.hot.hint'),
    }
  }

  /** The one-line hot-update status shown under the plugin connectivity row. */
  function hotStatusLine(): string | null {
    if (!hotWatch && !autoRestart.bundles && !autoRestart.dist) return null
    const on = (b: boolean): string => b ? t('tui.hot.on') : t('tui.hot.off')
    return t('tui.hot.line', {
      watch: on(hotWatch !== null),
      bundles: on(autoRestart.bundles),
      dist: on(autoRestart.dist),
    })
  }

  /** Channel 1 toggle: watch / stop watching client-plugin bundles. */
  function toggleHotWatch(): string {
    if (hotWatch) {
      hotWatch.dispose()
      hotWatch = null
      pushHotEvent(t('tui.hot.watchStopped'))
      return t('tui.hot.watchStopped')
    }
    const ctx = dshCtx()
    const bundles = resolveClientBundlePaths({ home, profile, checkout: ctx.checkout, poolDir: ctx.poolDir })
    if (bundles.length === 0) return t('tui.hot.watchNone')
    hotWatch = {
      count: bundles.length,
      dispose: watchClientBundles({
        home, profile, checkout: ctx.checkout, poolDir: ctx.poolDir,
        onEvent: (e) => {
          const label = (e.name ?? '') + (e.detail ? ' — ' + e.detail : '')
          pushHotEvent(t('tui.hot.ev.' + e.kind, { name: e.name ?? '', detail: e.detail ?? '' }))
          paint()
        },
      }),
    }
    pushHotEvent(t('tui.hot.watchStarted', { n: String(bundles.length) }))
    return t('tui.hot.watchStarted', { n: String(bundles.length) })
  }

  /** Channel 3 toggle: auto-restart on bundle-list / dist changes. */
  function toggleAutoRestart(key: 'bundles' | 'dist'): string {
    autoRestart[key] = !autoRestart[key]
    restartWatch?.dispose()
    restartWatch = null
    if (autoRestart.bundles || autoRestart.dist) {
      restartWatch = {
        dispose: watchRestartTriggers({
          home, profile, checkout: dshCtx().checkout,
          watchBundles: autoRestart.bundles, watchDist: autoRestart.dist,
          onTrigger: (reason) => { void restartFor(reason) },
        }),
      }
    }
    const msg = key === 'bundles'
      ? (autoRestart.bundles ? t('tui.hot.bundlesOnMsg') : t('tui.hot.bundlesOffMsg'))
      : (autoRestart.dist ? t('tui.hot.distOnMsg') : t('tui.hot.distOffMsg'))
    pushHotEvent(msg)
    return msg
  }

  /** Channel 3 payload: a supervised restart of the current launcher child. */
  async function restartSupervised(reason: 'bundles' | 'dist'): Promise<string | undefined> {
    if (!activeGuard) return t('tui.hot.restart.needLauncher')
    if (!report) return t('tui.hot.restart.needLauncher')
    message = t('tui.hot.restart.triggered', { reason })
    paint()
    const old = activeGuard
    old.supervisor.kill()
    try { await old.supervisor.exit } catch { /* ignore */ }
    // Give the port a moment to drain before the respawn binds it.
    await new Promise((r) => setTimeout(r, 800))
    const guardOpts: GuardOptions = {
      home, profile, command: report.command, cwd: report.cwd, port: opts.port ?? report.port,
      dshEnv: {}, autoConfirm: true, retries: 1,
      confirmGoodMs: opts.confirmMs, uiTimeoutMs: opts.uiTimeoutMs, threshold: opts.threshold,
    }
    try {
      const verdict = await superviseBoot(guardOpts)
      if (verdict.ok) {
        activeGuard = { supervisor: verdict.supervisor, release: old.release, url: verdict.url }
        return t('tui.hot.restart.ok', { reason, url: verdict.url })
      }
      if (verdict.rolledBack) {
        const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
        if (second.ok) {
          activeGuard = { supervisor: second.supervisor, release: old.release, url: second.url }
          return t('tui.hot.restart.ok', { reason, url: second.url })
        }
        return second.failureKind === 'env'
          ? t('cli.envFailure', { error: second.error ?? '' })
          : t('tui.hot.restart.failed', { reason, kind: second.failureKind })
      }
      return verdict.failureKind === 'env'
        ? t('cli.envFailure', { error: verdict.error ?? '' })
        : t('tui.hot.restart.failed', { reason, kind: verdict.failureKind })
    } catch (err) {
      return t('console.launch.guardError', { msg: String(err instanceof Error ? err.message : err) })
    }
  }

  async function restartFor(reason: 'bundles' | 'dist'): Promise<void> {
    const r = await restartSupervised(reason)
    if (r !== undefined) { message = r; pushHotEvent(r) }
    paint()
  }

  /** Apply a plugin-manager op result; for patch-insert ops on a live DSH,
   *  verify the config HMR actually landed (channel 2) and report it. */
  function applyPluginOp(r: { ok: boolean; message: string; mechanism?: 'bundle' | 'patch' }, name: string, wantEnabled: boolean): void {
    message = r.message
    pluginUseFileState = true
    if (!r.ok || r.mechanism !== 'patch' || !isHeartbeatFresh(home)) return
    void (async () => {
      const vr = await verifyPatchInsertApplied({ home, name, wantEnabled })
      if (vr.applied === true) message = t('tui.hot.verify.applied', { name })
      else if (vr.applied === null) message = t('tui.hot.verify.pending', { name })
      else message = t('tui.hot.verify.failed', { name, detail: vr.detail ?? '' })
      paint()
    })()
  }

  /** Restore the profile from the backup at the flat `cursor` (auto/manual). */
  function restoreBackupAt(cursor: number): void {
    const dir = backupAt(cursor)
    if (!dir || !isUsable(dir)) { message = t('tui.backups.needSnap', { dir: dir ?? '-' }); return }
    manualRestore(home, profile, dir, log)
    message = t('console.restore.done') + '  ' + basename(dir)
    refreshBackups()
  }

  let guardRunning = false
  async function launchGuard(): Promise<void> {
    if (activeGuard) { message = t('console.launch.alreadyRunning'); return }
    if (guardRunning) return
    guardRunning = true
    message = '…'
    paint()
    const fresh = await preflight({ cwd: opts.cwd, port: opts.port, lang })
    const fatal = fresh.problems.filter(x => x.sev === 'error')
    if (fatal.length) { message = t('cli.fatal.title') + ' ' + fatal[0].message; guardRunning = false; return }
    if (!report) report = fresh
    let release: (() => void) | undefined
    try { release = acquireLock(home) } catch (e) { message = String(e instanceof Error ? e.message : e); guardRunning = false; return }
    const guardOpts: GuardOptions = {
      home, profile, command: fresh.command, cwd: fresh.cwd, port: opts.port ?? fresh.port,
      dshEnv: {}, autoConfirm: true, retries: 1,
      confirmGoodMs: opts.confirmMs, uiTimeoutMs: opts.uiTimeoutMs, threshold: opts.threshold,
    }
    try {
      const verdict = await superviseBoot(guardOpts)
      if (verdict.ok) { activeGuard = { supervisor: verdict.supervisor, release: release!, url: verdict.url }; message = t('console.launch.ok', { url: verdict.url }) }
      else if (verdict.rolledBack) {
        const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
        if (second.ok) { activeGuard = { supervisor: second.supervisor, release: release!, url: second.url }; message = t('console.launch.rolledBackOk', { url: second.url }) }
        else { message = t('console.launch.rolledBackFail', { kind: second.failureKind, dir: join(qaqDir(home), 'rolled-back') }); release?.() }
      } else if (verdict.rollbackCancelled) { message = t('console.launch.cancelledRollback', { dir: join(qaqDir(home), 'rolled-back') }); release?.() }
      else if (verdict.failureKind === 'env') { message = t('cli.envFailure', { error: verdict.error ?? '' }); release?.() }
      else { message = t('console.launch.failed', { kind: verdict.failureKind, error: verdict.error ?? '' }); release?.() }
    } catch (err) {
      message = t('console.launch.guardError', { msg: String(err instanceof Error ? err.message : err) })
      release?.()
    }
    guardRunning = false
  }

  return await new Promise<boolean>((resolvePromise) => {
    let timer: ReturnType<typeof setInterval>
    let dying = false

    const teardown = (): void => { if (dying) return; dying = true; clearInterval(timer); clearTimeout(autoMountTimer); if (sideGuard?.timer) { clearInterval(sideGuard.timer); sideGuard.timer = null } hotWatch?.dispose(); hotWatch = null; restartWatch?.dispose(); restartWatch = null; try { stdin.setRawMode?.(false) } catch { /* ignore */ } out.write(SHOW_CURSOR + '\n') }

    // Raw-mode arrow keys arrive as multi-byte escape sequences; delegate to an
    // incremental KeyParser so partial sequences across 'data' events are kept.
    const keys = new KeyParser()
    const move = (delta: number): void => {
      selected = (selected + delta + menuCount()) % menuCount()
      paint()
    }
    const exec = (idx: number): void => {
      void runAction(idx).then((quit) => { if (quit) done(); else paint() })
    }
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString()
      // --- Text input mode (filter / install path): whole-chunk, paste-aware ---
      // Terminal paste (incl. folder drag-drop) may arrive in one chunk with
      // bracketed-paste markers (\x1b[200~…\x1b[201~). Process it directly so
      // CJK / spaces / quoted paths survive instead of being dropped pebbles.
      if (view === 'plugins' && (pluginInput === 'filter' || pluginInput === 'path')) {
        let text = s
        if (/\x1b\[200~/.test(text)) { text = text.replace(/\x1b\[200~/g, '') }
        if (/\x1b\[201~/.test(text)) { text = text.replace(/\x1b\[201~/g, '') }
        if (text.includes('\x1b[200~') || text.includes('\x1b[201~')) { /* incomplete markers handled below */ }
        // Process each decoded character; a leading \x1b[200~/trailing \x1b[201~
        // bracketed-paste marker was already stripped above. A partial trailing
        // marker (split across chunks) is left: its body arrives next chunk and is
        // appended then; a lone \x1b here cancels.
        for (let i = 0; i < text.length; i++) {
          const c = text[i]
          if (c === '\x1b') { pluginInput = 'none'; resetInputBuf(); paint(); return }
          if (c === '\x07') continue
          const code = c.charCodeAt(0)
          if (c === '\r' || c === '\n') {
            if (pluginInput === 'filter') { pluginFilter = pluginInputBuf.toLowerCase().trim(); pluginInput = 'none'; resetInputBuf(); pluginCursor = 0; pluginPage = 0 }
            else { message = installFromPath(pluginInputBuf.trim()); pluginInputBuf = ''; pluginPage = 0 }
            paint(); return
          }
          if (c === '\x7f' || c === '\b') { pluginInputBuf = pluginInputBuf.slice(0, -1); continue }
          if (code === 0) continue
          if (code >= 0x20) { pluginInputBuf += c } // printable incl. UTF-8 chars
        }
        paint()
        return
      }
      for (const ch of s) {
        const k = keys.feed(ch)
        if (view === 'logs') {
          // Log-viewer keymap: 1-4 switch tab, up/down scroll, q/Esc/Enter back.
          switch (k) {
            case 'up': logScroll = Math.min(logLines.length, logScroll + 1); paint(); return
            case 'down': logScroll = Math.max(0, logScroll - 1); paint(); return
            case 'esc':
            case 'enter':
            case 'space': view = 'menu'; message = t('tui.msg.placeholder'); paint(); return
            case 'ctrl-c': done(); return
            case 'char': {
              if (ch === 'q') { view = 'menu'; message = t('tui.msg.placeholder'); paint(); return }
              const ti = Number(ch)
              if (Number.isInteger(ti) && ti >= 1 && ti <= LOG_TABS.length) { enterLogs(LOG_TABS[ti - 1]); paint(); return }
              break
            }
            default: break
          }
          continue
        }
        if (view === 'plugins') {
          // Scan-pick mode: up/down select a discovered candidate, Enter installs.
          if (pluginInput === 'scan') {
            if (k === 'up') { pluginScanCursor = pluginScanCursor <= 0 ? 0 : pluginScanCursor - 1; paint(); return }
            if (k === 'down') { pluginScanCursor = Math.min(pluginScan.length - 1, pluginScanCursor + 1); paint(); return }
            if (k === 'enter') {
              const c = pluginScan[Math.max(0, Math.min(pluginScanCursor, pluginScan.length - 1))]
              pluginInput = 'none'
              if (c) { const ctx = dshCtx(); applyPluginOp(installPluginModule({ profileDir: ctx.profileDir, profile, name: c.name, source: c.dir, poolDir: ctx.poolDir }, new Logger(home), lang), c.name, true) }
              pluginScan = []
              paint(); return
            }
            if (ch === '\x1b') { pluginInput = 'none'; pluginScan = []; paint(); return }
            if (k === 'ctrl-c') { done(); return }
            continue
          }
          // (filter/path text input is handled chunk-wise at the top of onData for
          // paste/UTF-8 support; only scan-pick + the list keymap reach here.)
          switch (k) {
            case 'up': pluginCursor = clampPluginCursor(pluginCursor - 1); paint(); return
            case 'down': pluginCursor = clampPluginCursor(pluginCursor + 1); paint(); return
            case 'left': pluginPage = Math.max(0, pluginPage - 1); pluginCursor = 0; paint(); return
            case 'right': pluginPage += 1; pluginCursor = 0; paint(); return
            case 'esc':
            case 'space': view = 'menu'; message = t('tui.msg.placeholder'); paint(); return
            case 'ctrl-c': done(); return
            case 'char': {
              if (ch === 'q') { view = 'menu'; message = t('tui.msg.placeholder'); paint(); return }
              const ctx = dshCtx()
              const target = currentTarget(ctx, Math.max(12, out.rows || 24))
              if (ch === 'e' && target) { applyPluginOp(setPluginEnabled({ profileDir: ctx.profileDir, profile, name: target.name, enabled: true, checkout: ctx.checkout, poolDir: ctx.poolDir }, new Logger(home), lang), target.name, true); paint(); return }
              if (ch === 'd' && target) { applyPluginOp(setPluginEnabled({ profileDir: ctx.profileDir, profile, name: target.name, enabled: false, checkout: ctx.checkout, poolDir: ctx.poolDir }, new Logger(home), lang), target.name, false); paint(); return }
              if (ch === 'u' && target) { applyPluginOp(uninstallPlugin({ profileDir: ctx.profileDir, profile, name: target.name, poolDir: ctx.poolDir }, new Logger(home), lang), target.name, false); paint(); return }
              if (ch === 'i') { pluginInput = 'path'; pluginInputBuf = ''; message = t('tui.plugins.installPrompt'); paint(); return }
              if (ch === '/') { pluginInput = 'filter'; pluginInputBuf = pluginFilter; paint(); return }
              if (ch === '[') { pluginPage = Math.max(0, pluginPage - 1); pluginCursor = 0; paint(); return }
              if (ch === ']') { pluginPage += 1; pluginCursor = 0; paint(); return }
              break
            }
            default: break
          }
          continue
        }
        if (view === 'backups') {
          // Backup-manager keymap: up/down move over the flat [auto, manual]
          // list, Enter restores the selected backup, (3) manual-backups key
          // not needed here (menu [3] does it), q/Esc return to the menu.
          const total = backupAuto.length + backupManual.length
          switch (k) {
            case 'up': backupCursor = total === 0 ? 0 : Math.max(0, backupCursor - 1); paint(); return
            case 'down': backupCursor = total === 0 ? 0 : Math.min(total - 1, backupCursor + 1); paint(); return
            case 'enter':
            case 'space': restoreBackupAt(backupCursor); paint(); return
            case 'esc': view = 'menu'; message = t('tui.msg.placeholder'); paint(); return
            case 'ctrl-c': done(); return
            case 'char': {
              if (ch === 'q') { view = 'menu'; message = t('tui.msg.placeholder'); paint(); return }
              break
            }
            default: break
          }
          continue
        }
        if (view === 'hot') {
          // Hot-update panel keymap: 1 watch bundles · 2 auto-restart on bundle
          // list · 3 auto-restart on dist · q/Esc back.
          switch (k) {
            case 'esc':
            case 'space': view = 'menu'; message = t('tui.msg.placeholder'); paint(); return
            case 'ctrl-c': done(); return
            case 'char': {
              if (ch === 'q') { view = 'menu'; message = t('tui.msg.placeholder'); paint(); return }
              if (ch === '1') { message = toggleHotWatch(); paint(); return }
              if (ch === '2') { message = toggleAutoRestart('bundles'); paint(); return }
              if (ch === '3') { message = toggleAutoRestart('dist'); paint(); return }
              break
            }
            default: break
          }
          continue
        }
        switch (k) {
          case 'up': move(-1); return
          case 'down': move(1); return
          case 'enter':
          case 'space': exec(selected); return
          case 'esc':
          case 'ctrl-c': done(); return
          case 'char': {
            if (ch === 'q') { done(); return }
            if (ch === 'j' || ch === '\t') { move(1); return }
            if (ch === 'k') { move(-1); return }
            const n = Number(ch)
            if (Number.isInteger(n) && n >= 1 && n <= menuCount()) { exec(n - 1); return }
            break
          }
          default: break
        }
      }
    }

    function done(): void {
      teardown()
      stdin.off('data', onData)
      resolvePromise(true)
    }

    try { stdin.setRawMode?.(true) } catch { /* non-tty won't reach here */ }
    stdin.resume()
    stdin.on('data', onData)
    timer = setInterval(paint, TICK_MS)
    paint()
  })
}
