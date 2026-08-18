/**
 * QAQ 交互式守卫控制台（懒人脚本 GUI：一个可见 CMD 窗口里的菜单）。
 * 提供一键启动守卫、查看状态、手动备份/回滚、重置计数、自动挂载
 * dsh-qaq 备份插件、查看实时日志等功能。
 *
 * UI 语言：直接 `qaq console` / `qaq tui` 默认中文（可用 --lang en / $QAQ_LANG=en 切换）。
 */
import * as readline from 'node:readline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readState, profileState } from './store.ts'
import { qaqDir, resolveDshHome } from './paths.ts'
import { Logger } from './log.ts'
import { preflight, problemBanner, launchSummary, type EnvReport } from './env.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import type { DshSupervisor } from './spawn-dsh.ts'
import { runTui } from './tui.ts'
import { manualBackup, manualRestore, isUsable } from './rollback.ts'
import { acquireLock } from './store.ts'
import { installPlugin } from './install-plugin.ts'
import { makeT, resolveLang, type Lang, type T } from './i18n.ts'

/** Tunables that flow from the CLI into the console menu. */
export interface ConsoleOpts {
  yes?: boolean
  port?: number
  cwd?: string
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
  lang?: Lang
}

/**
 * The supervised dsh web currently running under this console. While set, the
 * guard lock is held (released on child exit) and a second supervised launch is refused.
 */
let activeGuard: { supervisor: DshSupervisor; release: () => void } | null = null
let t: T = makeT('zh')
let lang: Lang = 'zh'

const RESET = '\x1b[0m'
const RED = '\x1b[31m'
const GRN = '\x1b[32m'
const YEL = '\x1b[33m'
const CYN = '\x1b[36m'
const BOLD = '\x1b[1m'

function c(code: string, s: string): string { return code + s + RESET }

/**
 * A line-queued menu input helper. readline's `question()` drops lines that
 * arrive before the prompt is asked (piped/redirected stdin delivers them
 * during e.g. the preflight wait, then closes — the menu would silently lose
 * the input and exit). This buffers every 'line' immediately and the prompt
 * consumes the queue; EOF (stdin closed) resolves as 'q' so a redirected run
 * exits cleanly instead of hanging.
 */
function createAsker(rl: readline.Interface): (prompt: string) => Promise<string> {
  const queue: string[] = []
  let waiter: ((s: string) => void) | null = null
  rl.on('line', (line) => {
    const value = line.trim().toLowerCase()
    if (waiter) { const w = waiter; waiter = null; w(value) }
    else queue.push(value)
  })
  rl.on('close', () => {
    // EOF (piped/redirected stdin): resolve an in-flight prompt as quit, or
    // enqueue 'q' so the next prompt quits cleanly with the exit message.
    if (waiter) { const w = waiter; waiter = null; w('q') }
    else queue.push('q')
  })
  return (prompt: string): Promise<string> => {
    process.stdout.write(prompt)
    const pending = queue.shift()
    if (pending !== undefined) return Promise.resolve(pending)
    return new Promise((res) => { waiter = res })
  }
}

function printState(home: string, profile: string): void {
  const state = readState(home)
  const p = profileState(state, profile)
  process.stdout.write('\n' + c(BOLD, t('console.state.title', { name: profile })) + '\n');
  process.stdout.write('  hostFailures:  ' + p.hostFailures + '\n');
  process.stdout.write('  uiFailures:    ' + p.uiFailures + '\n');
  process.stdout.write('  lastSuccess:   ' + (p.lastSuccess ?? '-') + '\n');
  process.stdout.write('  lastFailure:   ' + (p.lastFailure ? p.lastFailure.kind + ' @ ' + p.lastFailure.ts + '  ' + (p.lastFailure.error ?? '').slice(0, 120) : '-') + '\n');
  process.stdout.write('  lastGood:      ' + (p.lastGoodSnapshot ?? t('console.state.noSnapshot')) + '\n');
  process.stdout.write('  rolledBackAt:  ' + (p.rolledBackAt ?? '-') + '\n');
}

function tailFile(path: string, maxBytes = 4000): void {
  try {
    const fd = readFileSync(path, 'utf8')
    const lines = fd.split('\n').filter(Boolean)
    const keep = lines.slice(Math.max(0, lines.length - 25));
    for (const ln of keep) process.stdout.write('  ' + ln + '\n');
  } catch { process.stdout.write('  ' + t('console.logs.none') + '\n') }
}

/** Arm the exit watcher for a healthy supervised child: release the guard lock
 * the moment it exits, and notify the console. */
function watchSupervisor(sup: DshSupervisor, release: () => void): void {
  void sup.exit.then((code) => {
    const g = activeGuard;
    activeGuard = null;
    try { g?.release() } catch { /* best effort */ }
    process.stdout.write(c(YEL, t('console.notify.exit', { code: String(code ?? '') })) + '\n');
  });
}

async function runLaunch(home: string, report: EnvReport, profile: string, opts: ConsoleOpts, ask: (p: string) => Promise<string>): Promise<void> {
  // Refuse a second supervised instance while one is already running here.
  if (activeGuard) {
    process.stdout.write(c(YEL, t('console.launch.alreadyRunning')) + '\n');
    return;
  }

  // Fresh preflight at launch time: the port/browser/env may have changed since
  // the banner was printed (e.g. a previous supervised child still holds it).
  const fresh = await preflight({ port: opts.port ?? report.port, cwd: opts.cwd, lang });
  const errors = fresh.problems.filter(x => x.sev === 'error');
  if (errors.length) {
    process.stdout.write(c(RED, t('console.launch.preflightError')) + '\n');
    for (const e of errors) process.stdout.write(c(RED, '  - ' + e.message + '  → ' + e.hint) + '\n');
    return;
  }

  process.stdout.write('\n' + c(GRN, t('console.launch.preflightPass')) + t('console.launch.preflightSuffix') + '\n');
  process.stdout.write(launchSummary(fresh, lang).split('\n').map(x => '  ' + x).join('\n') + '\n');

  const proceed = opts.yes || (await ask(c(YEL, t('console.launch.confirm')) + ' (y/N) ')).startsWith('y');
  if (!proceed) { process.stdout.write(t('console.launch.cancelled') + '\n'); return }

  let release: (() => void) | undefined;
  try { release = acquireLock(home) }
  catch (e) { process.stdout.write(c(RED, t('console.launch.error', { msg: String(e instanceof Error ? e.message : e) })) + '\n'); return }

  const guardOpts: GuardOptions = {
    home, profile, command: fresh.command, cwd: fresh.cwd, port: opts.port ?? fresh.port,
    dshEnv: {}, autoConfirm: true,
    retries: 1, confirmGoodMs: opts.confirmMs, uiTimeoutMs: opts.uiTimeoutMs, threshold: opts.threshold,
  };

  try {
    const verdict = await superviseBoot(guardOpts)
    if (verdict.ok) {
      // Keep the guard lock while the supervised child runs; release on exit.
      activeGuard = { supervisor: verdict.supervisor, release: release! };
      process.stdout.write('\n' + c(GRN, t('console.launch.ok', { url: verdict.url })) + '\n');
      process.stdout.write(c(CYN, t('console.launch.monitoring')) + '\n');
      await ask(t('console.logs.return'));
      watchSupervisor(verdict.supervisor, release!);
      return;
    }
    if (verdict.rolledBack) {
      process.stdout.write(c(YEL, t('console.launch.rolledBack')) + '\n');
      const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
      if (second.ok) {
        activeGuard = { supervisor: second.supervisor, release: release! };
        process.stdout.write(c(GRN, t('console.launch.rolledBackOk', { url: second.url })) + '\n');
        await ask(t('console.logs.return'));
        watchSupervisor(second.supervisor, release!);
        return;
      }
      process.stdout.write(c(RED, t('console.launch.rolledBackFail', { kind: second.failureKind, dir: join(qaqDir(home), 'rolled-back') })) + '\n');
    } else if (verdict.rollbackCancelled) {
      process.stdout.write(c(YEL, t('console.launch.cancelledRollback', { dir: join(qaqDir(home), 'rolled-back') })) + '\n');
    } else if (verdict.failureKind === 'env') {
      process.stdout.write(c(RED, t('cli.envFailure', { error: verdict.error ?? '' })) + '\n');
    } else {
      process.stdout.write(c(RED, t('console.launch.failed', { kind: verdict.failureKind, error: verdict.error ?? '' })) + '\n');
    }
  } catch (err) {
    process.stdout.write(c(RED, t('console.launch.guardError', { msg: String(err instanceof Error ? err.message : err) })) + '\n');
  } finally {
    // Release the lock only when no supervised child is still running under us.
    if (!activeGuard) release?.();
  }
}

/** Approximate terminal display width: CJK / fullwidth glyphs count as 2 columns. */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const wide = c === 0x2014 // em dash renders fullwidth in CJK console fonts
      || (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x33ff)
      || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

/** The persistent header re-printed after every screen clear. The box border
 * tracks the (localized) title's display width so both en and zh stay aligned. */
function printHeader(report: EnvReport): void {
  const title = t('console.header.title')
  const inner = displayWidth(title) + 2
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '┌' + '─'.repeat(inner) + '┐') + '\n');
  process.stdout.write(c(BOLD, '│ ' + title + ' │') + '\n');
  process.stdout.write(c(BOLD, '└' + '─'.repeat(inner) + '┘') + '\n');
  process.stdout.write(launchSummary(report, lang).split('\n').map(x => '  ' + x).join('\n') + '\n');
  if (report.problems.length) process.stdout.write(c(YEL, problemBanner(report, lang)) + '\n');
  process.stdout.write('\n');
}

async function runConsole(home: string, profile: string, opts: ConsoleOpts, ask: (p: string) => Promise<string>): Promise<void> {
  const report = await preflight({ port: opts.port, cwd: opts.cwd, lang })

  // One screen at a time: clear before every menu so the window never stacks
  // stale menus/output (the header is re-printed each time). No-op on non-TTY.
  const clearScreen = (): void => { if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H') }

  let lastNotice = ''
  let running = true;
  while (running) {
    clearScreen();
    printHeader(report);
    if (activeGuard) process.stdout.write(c(CYN, t('console.guard.running')) + '\n\n');
    if (lastNotice) process.stdout.write(c(GRN, t('console.notice.prefix') + lastNotice) + '\n\n');
    process.stdout.write(c(BOLD, t('console.menu.title')) + t('console.menu.profile', { name: profile }) + '\n');
    process.stdout.write('  ' + c(CYN, '[1]') + ' ' + t('console.menu.1') + '\n');
    process.stdout.write('  ' + c(CYN, '[2]') + ' ' + t('console.menu.2') + '\n');
    process.stdout.write('  ' + c(CYN, '[3]') + ' ' + t('console.menu.3') + '\n');
    process.stdout.write('  ' + c(CYN, '[4]') + ' ' + t('console.menu.4') + '\n');
    process.stdout.write('  ' + c(CYN, '[5]') + ' ' + t('console.menu.5') + '\n');
    process.stdout.write('  ' + c(CYN, '[6]') + ' ' + t('console.menu.6') + '\n');
    process.stdout.write('  ' + c(CYN, '[7]') + ' ' + t('console.menu.7') + '\n');
    process.stdout.write('  ' + c(CYN, '[q]') + ' ' + t('console.menu.q') + '\n');
    const choice = await ask(c(YEL, t('console.menu.prompt')));
    switch (choice) {
      case '1': case 'l': case 'launch': await runLaunch(home, report, profile, opts, ask); break
      case '2': case 's': case 'status': {
        printState(home, profile);
        await ask(t('console.logs.return'));
        break
      }
      case '3': case 'b': case 'backup': {
        manualBackup(home, profile, new Logger(home));
        lastNotice = t('console.backup.done');
        break
      }
      case '4': case 'r': case 'restore': {
        const state = readState(home);
        const p = profileState(state, profile);
        const good = p.lastGoodSnapshot ? join(qaqDir(home), p.lastGoodSnapshot.startsWith('history/') ? p.lastGoodSnapshot : 'history/' + p.lastGoodSnapshot) : null;
        const usable = good && isUsable(good);
        if (!usable) { lastNotice = t('console.restore.noSnapshot'); break }
        const confirm = await ask(c(YEL, t('console.restore.confirm')) + ' (y/N) ');
        if (confirm.startsWith('y')) { manualRestore(home, profile, good!, new Logger(home)); lastNotice = t('console.restore.done') }
        else lastNotice = t('console.launch.cancelled');
        break;
      }
      case '5': case 'reset': {
        const state = readState(home); const p = profileState(state, profile);
        p.hostFailures = 0; p.uiFailures = 0; delete p.lastFailure;
        await import('./store.ts').then(m => m.writeState(home, state));
        new Logger(home).access('reset counters via console for profile ' + profile, { profile, action: 'reset' });
        lastNotice = t('console.reset.done');
        break;
      }
      case '6': case 'i': case 'install': {
        const r = installPlugin(home, profile, new Logger(home), lang);
        lastNotice = r.message;
        break;
      }
      case '7': case 'v': case 'logs': {
        const logDir = join(qaqDir(home), 'log');
        process.stdout.write('\n' + c(BOLD, t('console.logs.error')) + '\n');
        tailFile(join(logDir, 'error.log'));
        process.stdout.write('\n' + c(BOLD, t('console.logs.access')) + '\n');
        tailFile(join(logDir, 'access.log'));
        process.stdout.write('\n' + c(BOLD, t('console.logs.host')) + '\n');
        tailFile(join(logDir, 'host.log'), 3000);
        await ask(t('console.logs.return'));
        break;
      }
      case 'q': case 'quit': case 'exit': running = false; break;
      default: lastNotice = t('console.menu.unknown');
    }
  }
  clearScreen();
  printHeader(report);
  process.stdout.write(c(BOLD, t('console.exit', { dir: join(qaqDir(home), 'log') })) + '\n');
}

/** Entry point: open the interactive console. */
export async function openConsole(profile = 'web', opts: ConsoleOpts = {}): Promise<void> {
  // On a real interactive terminal prefer the live full-screen TUI; otherwise
  // fall back to the plain one-screen-at-a-time menu below.
  if (await runTui(opts, profile)) return;
  const home = resolveDshHome();
  lang = opts.lang ?? resolveLang([]);
  t = makeT(lang);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = createAsker(rl);
  rl.on('SIGINT', () => {
    // Kill a supervised child so a Ctrl+C never leaves dsh web holding the port.
    if (activeGuard) { try { activeGuard.supervisor.kill() } catch { /* ignore */ } }
    process.stdout.write('\n(caught Ctrl+C)\n');
    rl.close();
    process.exit(130);
  });
  await runConsole(home, profile, opts, ask);
  rl.close();
}
