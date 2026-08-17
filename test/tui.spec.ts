import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFrame, runTui, computeLogWindow, diagnoseVerdict, LOG_TABS, LOG_HEADERS, isQaqMounted, type LogsView, type PluginsView, type BackupsView, type HotView, type TuiMode, type SideGuardStatus } from '../src/tui.ts'
import { makeT } from '../src/i18n.ts'
import { displayWidth } from '../src/width.ts'
import type { WatchVerdict } from '../src/watch.ts'

let home = ''
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-tui-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

function frameCols(width: number, selected = 0, color = false, logs: LogsView | null = null, rows = 24, mode: TuiMode = 'idle', plugins: PluginsView | null = null, conn: 'connected' | 'connecting' | 'disconnected' = 'disconnected'): string {
  return buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: '（尚无操作 — 按下方按键）', report: null, mode, conn, logs, plugins, cols: Math.max(74, width), rows, selected, color, clearFirst: false })
}

/** Strip full ANSI CSI sequences so we measure only the on-screen columns. */
function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '') }

describe('TUI dashboard frame', () => {
  it('no rendered line overflows the WIDTH (min 74 for the banner) even with fullwidth CJK', () => {
    for (const col of [40, 74, 80, 100, 120]) {
      const w = Math.max(74, col) // buildFrame floors at 74 to fit the banner
      const body = stripAnsi(frameCols(col))
      for (const ln of body.split('\n').filter(Boolean)) {
        expect(displayWidth(ln)).toBeLessThanOrEqual(w)
      }
    }
  })

  it('clears the screen only on the first frame (no per-tick full clear → no flicker)', () => {
    const first = buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'idle', conn: 'disconnected', logs: null, plugins: null, cols: 80, rows: 24, selected: 0, color: false, clearFirst: true })
    const later = buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'idle', conn: 'disconnected', logs: null, plugins: null, cols: 80, rows: 24, selected: 0, color: false, clearFirst: false })
    expect(first.includes('\x1b[2J')).toBe(true) // full clear on entry
    expect(later.includes('\x1b[2J')).toBe(false) // repaints overwrite in place
  })

  it('renders the QAQ block-art wordmark and rich double-row separators', () => {
    // Use a tall frame so the top banner rows are not trimmed by the height budget.
    const frame = stripAnsi(frameCols(80, 0, false, null, 48))
    expect(frame).toContain('@@@@@')
    expect(frame).toContain('═') // double-line separators
  })

  it('renders a vertical menu that marks the selected item with ◈', () => {
    const frame0 = stripAnsi(frameCols(80, 0))
    const frame3 = stripAnsi(frameCols(80, 3))
    expect(frame0).toMatch(/◈\s*启动守卫/)
    expect(frame3).toMatch(/◈\s*回滚/)
  })

  it('localizes the state labels to Chinese', () => {
    const frame = stripAnsi(frameCols(80))
    expect(frame).toContain('主机失败')
    expect(frame).toContain('UI 失败')
    expect(frame).toContain('最近成功')
  })

  it('falls back (returns false) when stdin/stdout are not TTYs', async () => {
    expect(await runTui({}, 'web')).toBe(false)
  })
})

describe('TUI log-view menu wiring', () => {
  it('exposes the four log tabs in 1..4 order with stable headers', () => {
    expect(LOG_TABS).toEqual(['error', 'access', 'host', 'qaq'])
    expect(LOG_HEADERS.error).toBe('error.log')
    expect(LOG_HEADERS.qaq).toBe('qaq.log')
  })

  it('includes the Logs item in the TUI menu (between Mount and Language)', () => {
    // Parse the rendered menu rows (two-space indented, ◈-marked) and assert the
    // order: Mount < Logs < Language, so the digit hotkey for Logs is stable.
    const mountIdx = indexOfColumn('挂载 qaq 插件')
    const langIdx = indexOfColumn('语言  <')
    const logsCol = indexOfColumn('日志')
    expect(logsCol).toBeGreaterThan(mountIdx)
    expect(logsCol).toBeLessThan(langIdx)
  })

  it('renders the log panel header, the N/M counter, and log lines when logs are active', () => {
    const logs: LogsView = { title: 'error.log', lines: ['ERR one', 'ERR two'], total: 2, scroll: 0 }
    const frame = stripAnsi(frameCols(80, 0, false, logs))
    expect(frame).toContain('error.log')
    expect(frame).toContain('ERR one')
    expect(frame).toContain('ERR two')
    expect(frame).toContain('2 / 2')
  })

  it('shows the log-viewer bottom hint (1-4 / scroll / q-Esc) instead of the menu hint', () => {
    const logs: LogsView = { title: 'qaq.log', lines: [], total: 0, scroll: 0 }
    const frame = stripAnsi(frameCols(80, 0, false, logs))
    expect(frame).toContain('1-4 切换日志')
    // The log hint must not show the menu hint text.
    expect(frame).not.toContain('Enter 执行')
  })

  it('shows "(no logs)" placeholder when the active tab has no lines', () => {
    const logs: LogsView = { title: 'host.log', lines: [], total: 0, scroll: 0 }
    const frame = stripAnsi(frameCols(80, 0, false, logs))
    expect(frame).toContain('（无日志）')
  })
})

describe('computeLogWindow (pure scroll/slice)', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'] // newest last => f is newest

  it('clamps negative scroll to 0 (newest-bottom shows the tail)', () => {
    expect(computeLogWindow(lines, -5, 3).lines).toEqual(['d', 'e', 'f'])
    expect(computeLogWindow(lines, 0, 3).lines).toEqual(['d', 'e', 'f'])
  })

  it('clamps scroll above the total to the bottom (all lines visible from top)', () => {
    const w = computeLogWindow(lines, 100, 3)
    expect(w.lines).toEqual(['a', 'b', 'c'])
    expect(w.from).toBe(0) // scrolled to the very start of the buffer
  })

  it('walks backward from newest when scrolling up', () => {
    expect(computeLogWindow(lines, 1, 4).lines).toEqual(['b', 'c', 'd', 'e'])
    expect(computeLogWindow(lines, 2, 2).lines).toEqual(['c', 'd'])
  })

  it('returns an empty window when maxShown <= 0 (degenerate terminal height)', () => {
    expect(computeLogWindow(lines, 0, 0).lines).toEqual([])
    expect(computeLogWindow(lines, 0, -1).lines).toEqual([])
  })

  it('hands back an empty window for an empty buffer', () => {
    const w = computeLogWindow([], 0, 5)
    expect(w.lines).toEqual([])
    expect(w.from).toBe(0)
    expect(w.to).toBe(0)
  })

  it('reports from/to exactly for a full-window slice', () => {
    const w = computeLogWindow(lines, 1, 4)
    expect(w.from).toBe(1)
    expect(w.to).toBe(5)
  })
})

describe('TUI mode indicator (launcher / sideload / idle)', () => {
  it('shows the idle mode line when idle', () => {
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'idle'))).toContain('模式：空闲')
  })

  it('shows the launcher mode line when a supervised child is running', () => {
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'launcher'))).toContain('模式：启动器')
  })

  it('shows the sideload mode line when an external DSH is detected', () => {
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'sideload'))).toContain('模式：侧载')
  })

  it('mode line never overflows even at narrow width', () => {
    expect(displayWidth(stripAnsi(frameCols(40, 0, false, null, 24, 'sideload')))).toBeGreaterThan(0)
  })

  it('shows the real dsh-qaq connection status (connected/connecting/disconnected)', () => {
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'idle', null, 'connected'))).toContain('dsh-qaq 已连接')
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'idle', null, 'connecting'))).toContain('dsh-qaq 连接中')
    expect(stripAnsi(frameCols(80, 0, false, null, 24, 'idle', null, 'disconnected'))).toContain('dsh-qaq 未连接')
  })
})

describe('TUI continuous sideload guard', () => {
  function vg(over: Partial<WatchVerdict>): WatchVerdict {
    return { ok: false, kind: 'unknown', error: undefined, rolledBack: false, port: 3080, source: 'heartbeat', ...over }
  }

  it('diagnoseVerdict labels each verdict kind (healthy after rollback)', () => {
    const zh = makeT('zh')
    expect(diagnoseVerdict(vg({ ok: true, kind: 'ok' }), zh)).toBe('健康')
    expect(diagnoseVerdict(vg({ rolledBack: true, kind: 'ui' }), zh)).toBe('已回滚到 last-good')
    expect(diagnoseVerdict(vg({ kind: 'host', error: 'boom' }), zh)).toBe('host 失败')
    expect(diagnoseVerdict(vg({ kind: 'ui', error: 'red' }), zh)).toBe('ui 失败')
    expect(diagnoseVerdict(vg({ kind: 'unknown', error: 'UI not settled' }), zh)).toBe('UI not settled')
    expect(diagnoseVerdict(vg({ kind: 'unknown', error: undefined }), zh)).toBe('尚未稳定')
  })

  it('renders the running sideload guard status line (url + outcome)', () => {
    const sg: SideGuardStatus = { url: 'http://127.0.0.1:3080', last: '健康', lastOk: true, intervalMs: 15000 }
    const frame = stripAnsi(buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'sideload', conn: 'connected', sideGuard: sg, logs: null, plugins: null, cols: 80, rows: 26, selected: 0, color: false, clearFirst: false }))
    expect(frame).toContain('侧载守卫：运行中')
    expect(frame).toContain('http://127.0.0.1:3080')
    expect(frame).toContain('健康')
    // The status line never overflows.
    for (const ln of frame.split('\n').filter(Boolean)) expect(displayWidth(ln)).toBeLessThanOrEqual(80)
  })

  it('shows a non-healthy outcome in the sideload status line', () => {
    const sg: SideGuardStatus = { url: 'http://127.0.0.1:3080', last: 'ui 失败', lastOk: false, intervalMs: 15000 }
    const frame = stripAnsi(buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'sideload', conn: 'disconnected', sideGuard: sg, logs: null, plugins: null, cols: 80, rows: 26, selected: 0, color: false, clearFirst: false }))
    expect(frame).toContain('ui 失败')
  })
})

describe('TUI plugin cursor alignment', () => {
  it('cursor 0 marks the first plugin row (no status row offset) — the off-by-one regression', () => {
    // rows[0]=header, rows[1..]=plugins. Cursor 0 must select plugin row[1].
    const plugins: PluginsView = { title: 't', rows: ['名称', 'precise-cache', 'qaq'], cursor: 0, total: 2, page: 0, pages: 1, hint: 'h' }
    const frame = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', plugins))
    expect(frame).toContain('◈ precise-cache') // first plugin selected
    // Cursor 1 selects the second plugin.
    const p2: PluginsView = { ...plugins, cursor: 1 }
    const f2 = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', p2))
    expect(f2).toContain('◈ qaq')
  })
})

describe('TUI plugin-manager panel', () => {
  it('renders the plugin rows (short names, no dsh- prefix, no check glyphs) with the cursor marked', () => {
    const plugins: PluginsView = {
      title: '插件 · web',
      rows: ['名称  (绿=已启用，红=已停用)', 'qaq', 'theme'],
      cursor: 1,
      total: 2,
      page: 0,
      pages: 1,
      hint: '↑/↓ 选择 · e 启用 · d 停用 · u 卸载 · i 安装 · / 搜索 · [ ] 翻页 · q 返回',
    }
    const frame = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', plugins))
    expect(frame).toContain('qaq')
    expect(frame).toContain('theme')
    // No `dsh-` prefix and no check/cross glyphs.
    expect(frame).not.toContain('✓')
    expect(frame).not.toContain('✗')
    // Cursor (◈) highlights the selected plugin row (index 1 -> the second plugin).
    expect(frame).toContain('◈ theme')
  })

  it('adds a closing horizontal rule at the bottom of the plugin list', () => {
    const plugins: PluginsView = { title: 't', rows: ['名称', 'a', 'b'], cursor: 0, total: 2, page: 0, pages: 1, hint: 'h' }
    const frame = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', plugins))
    // A double rule separates the list body from the bottom hint.
    expect(frame).toContain('═')
  })

  it('renders the pagination header when there are multiple pages', () => {
    const plugins: PluginsView = { title: 't', rows: ['名称', 'a'], cursor: 0, total: 50, page: 1, pages: 10, hint: 'h' }
    const frame = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', plugins))
    expect(frame).toContain('2/10')
    expect(frame).toContain('共 50')
  })

  it('renders the plugin-manager bottom hint instead of the menu hint', () => {
    const plugins: PluginsView = { title: 't', rows: ['h'], cursor: -1, total: 0, page: 0, pages: 1, hint: '↑/↓ 选择 · e 启用 · d 停用 · u 卸载 · i 安装路径 · / 搜索 · [ ] 翻页 · q 返回' }
    const frame = stripAnsi(frameCols(80, 0, false, null, 24, 'idle', plugins))
    expect(frame).toContain('e 启用') // hint visible
    expect(frame).not.toContain('Enter 执行') // menu hint replaced
  })

  it('plugin panel takes priority over the log panel when both are set', () => {
    const logs: LogsView = { title: 'qaq.log', lines: ['line'], total: 1, scroll: 0 }
    const plugins: PluginsView = { title: '插件 · web', rows: ['名称', '✓ dsh-x'], cursor: 0, total: 1, page: 0, pages: 1, hint: 'x' }
    const frame = stripAnsi(frameCols(80, 0, false, logs, 24, 'idle', plugins))
    expect(frame).toContain('插件')
    expect(frame).toContain('dsh-x')
    expect(frame).not.toContain('qaq.log')
  })
})

describe('TUI backup-management panel', () => {
  function bk(backups: BackupsView): string {
    return stripAnsi(buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'idle', conn: 'disconnected', backups, logs: null, plugins: null, cols: 90, rows: 30, selected: 0, color: false, clearFirst: false }))
  }

  it('renders auto + manual sections with an empty "(none)" placeholder', () => {
    const b: BackupsView = {
      title: '备份 · web', autoCount: 1, manualCount: 0, cursor: 0,
      rows: [
        { text: '备份 · web', kind: 'title' },
        { text: '自动备份（1）', kind: 'section' },
        { text: '2026-08-15T00-00-00', kind: 'auto' },
        { text: '手动备份（0）', kind: 'section' },
        { text: '  （无）', kind: 'section' },
      ],
      hint: '↑/↓ 选择 · Enter 还原 · q 返回',
    }
    const frame = bk(b)
    expect(frame).toContain('自动备份')
    expect(frame).toContain('手动备份')
    expect(frame).toContain('（无）')
    expect(frame).toContain('◈ 2026-08-15T00-00-00') // selected auto row
    expect(frame).toContain('↑/↓ 选择') // hint
  })

  it('marks the flat cursor across both sections (auto first, then manual)', () => {
    const b: BackupsView = {
      title: '备份 · web', autoCount: 1, manualCount: 1, cursor: 1,
      rows: [
        { text: 'title', kind: 'title' },
        { text: '自动备份（1）', kind: 'section' },
        { text: 'auto-1', kind: 'auto' },
        { text: '手动备份（1）', kind: 'section' },
        { text: 'manual-1', kind: 'manual' },
      ],
      hint: 'h',
    }
    const frame = bk(b)
    expect(frame).toContain('◈ manual-1') // flat cursor 1 -> the manual row
    // The auto row is not selected.
    expect(frame).toMatch(/auto-1/) // present but not ◈-marked necessarily
  })
})

/** Column index (0-based line in the frame) whose text contains `needle`. */
function indexOfColumn(needle: string): number {
  const rows = stripAnsi(frameCols(120)).split('\n')
  const i = rows.findIndex(r => r.includes(needle))
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}

describe('TUI hot-update panel', () => {
  function hot(h: HotView, hotLine: string | null = null): string {
    return stripAnsi(buildFrame({ home, profile: 'web', t: makeT('zh'), lang: 'zh', activeGuard: null, message: 'x', report: null, mode: 'idle', conn: 'disconnected', hot: h, hotLine, logs: null, plugins: null, cols: 90, rows: 30, selected: 0, color: false, clearFirst: false }))
  }

  it('includes the Hot update menu item (between Sideload and Language)', () => {
    const sideloadIdx = indexOfColumn('侧载 watch')
    const langIdx = indexOfColumn('语言  <')
    const hotIdx = indexOfColumn('热更新')
    expect(hotIdx).toBeGreaterThan(sideloadIdx)
    expect(hotIdx).toBeLessThan(langIdx)
  })

  it('renders the three toggle rows and an events placeholder when active', () => {
    const h: HotView = {
      title: '热更新 · web',
      rows: [
        '[1] 监控 client 插件 bundle 热更：关',
        '[2] bundle 列表变化自动重启：关',
        '[3] web dist 变化自动重启：关',
      ],
      events: [],
      hint: '1 监控 client bundle · 2 bundle 列表变化自动重启 · 3 dist 变化自动重启 · q 返回',
    }
    const frame = hot(h)
    expect(frame).toContain('[1] 监控 client 插件 bundle 热更')
    expect(frame).toContain('[2] bundle 列表变化自动重启')
    expect(frame).toContain('[3] web dist 变化自动重启')
    expect(frame).toContain('（暂无事件）')
    expect(frame).toContain('1 监控 client bundle') // hint
  })

  it('renders recent hot-update events newest first', () => {
    const h: HotView = {
      title: '热更新 · web',
      rows: ['[1] 监控 client 插件 bundle 热更：开', '[2] bundle 列表变化自动重启：关', '[3] web dist 变化自动重启：关'],
      events: ['已验证：dsh-ui-thing', '变更：dsh-ui-thing'],
      hint: 'h',
    }
    const frame = hot(h)
    expect(frame).toContain('已验证：dsh-ui-thing')
    expect(frame).toContain('变更：dsh-ui-thing')
  })

  it('shows the live hot status line when any toggle is on', () => {
    const frame = hot({ title: '热更新 · web', rows: [], events: [], hint: 'h' }, '热更 开 · bundle 重启 关 · dist 重启 关')
    expect(frame).toContain('热更 开 · bundle 重启 关 · dist 重启 关')
  })

  it('renders no hot status line when everything is off', () => {
    const frame = hot({ title: '热更新 · web', rows: [], events: [], hint: 'h' })
    expect(frame).not.toContain('热更 ')
  })
})

describe('isQaqMounted (auto-mount decision on dashboard open)', () => {
  const pr = (name: string): string => join(home, 'profiles', name)

  it('is false when dsh-qaq is not in the bundle list', () => {
    // 'web' profile (from beforeAll) has only @deepseek-ai/dsh-base.
    expect(isQaqMounted(home, 'web')).toBe(false)
  })

  it('is false when listed but the module is missing (orphan)', () => {
    mkdirSync(pr('orphan'), { recursive: true })
    writeFileSync(join(pr('orphan'), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['dsh-qaq'] } } }))
    expect(isQaqMounted(home, 'orphan')).toBe(false)
  })

  it('is true when listed and resolvable from the profile node_modules', () => {
    mkdirSync(join(pr('mounted'), 'node_modules', 'dsh-qaq'), { recursive: true })
    writeFileSync(join(pr('mounted'), 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['dsh-qaq'] } } }))
    writeFileSync(join(pr('mounted'), 'node_modules', 'dsh-qaq', 'package.json'), JSON.stringify({ name: 'dsh-qaq' }))
    expect(isQaqMounted(home, 'mounted')).toBe(true)
  })
})
