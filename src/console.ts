/**
 * QAQ 交互式守卫控制台（傻瓜式 GUI：一个可见 CMD 窗口里的菜单）。
 * 提供一键启动守卫、查看状态、手动备份/回滚、重置计数、自动挂载
 * dsh-qaq 备份插件、查看实时日志等功能，全部中文引导，无需记命令。
 */
import * as readline from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readState, profileState } from './store.ts'
import { qaqDir, resolveDshHome } from './paths.ts'
import { Logger } from './log.ts'
import { preflight, problemBanner, launchSummary, type EnvReport } from './env.ts'
import { superviseBoot, type GuardOptions } from './guard.ts'
import type { DshSupervisor } from './spawn-dsh.ts'
import { manualBackup, manualRestore, isUsable } from './rollback.ts'
import { acquireLock } from './store.ts'
import { installPlugin } from './install-plugin.ts'

/** Tunables that flow from the CLI into the console menu. */
export interface ConsoleOpts {
  yes?: boolean
  port?: number
  confirmMs?: number
  uiTimeoutMs?: number
  threshold?: number
}

/**
 * The supervised dsh web currently running under this console. While set, the
 * guard lock is held (released on child exit) and a second 一键启动 is refused.
 */
let activeGuard: { supervisor: DshSupervisor; release: () => void } | null = null

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

function pad(s: string, n: number): string { return (s + ' '.repeat(Math.max(0, n - s.length))) }

function printState(home: string, profile: string): void {
  const state = readState(home)
  const p = profileState(state, profile)
  process.stdout.write('\n' + c(BOLD, '—— 当前守卫状态（profile ' + profile + '）——') + '\n');
  process.stdout.write('  hostFailures:  ' + p.hostFailures + '\n');
  process.stdout.write('  uiFailures:    ' + p.uiFailures + '\n');
  process.stdout.write('  lastSuccess:   ' + (p.lastSuccess ?? '-') + '\n');
  process.stdout.write('  lastFailure:   ' + (p.lastFailure ? p.lastFailure.kind + ' @ ' + p.lastFailure.ts + '  ' + (p.lastFailure.error ?? '').slice(0, 120) : '-') + '\n');
  process.stdout.write('  lastGood:      ' + (p.lastGoodSnapshot ?? '（尚无快照）') + '\n');
  process.stdout.write('  rolledBackAt:  ' + (p.rolledBackAt ?? '-') + '\n');
}

function tailFile(path: string, maxBytes = 4000): void {
  try {
    const st = existsSync(path) ? { size: readFileSync(path).length } : { size: 0 }
    const fd = readFileSync(path, 'utf8')
    const lines = fd.split('\n').filter(Boolean)
    const keep = lines.slice(Math.max(0, lines.length - 25));
    for (const ln of keep) process.stdout.write('  ' + ln + '\n');
  } catch { process.stdout.write('  （无日志）\n') }
}

/** Arm the exit watcher for a healthy supervised child: release the guard lock
 * the moment it exits, and notify the console. */
function watchSupervisor(sup: DshSupervisor, release: () => void): void {
  void sup.exit.then((code) => {
    const g = activeGuard;
    activeGuard = null;
    try { g?.release() } catch { /* best effort */ }
    process.stdout.write('\n' + c(YEL, '[通知] dsh web 已退出 (code=' + code + ')，守卫锁已释放。') + '\n');
  });
}

async function runLaunch(home: string, report: EnvReport, profile: string, opts: ConsoleOpts, ask: (p: string) => Promise<string>): Promise<void> {
  // Refuse a second supervised instance while one is already running here.
  if (activeGuard) {
    process.stdout.write(c(YEL, '\n[守卫] 已有一个受监督的 dsh web 在运行。返回菜单等待其退出后再启动。') + '\n');
    return;
  }

  // Fresh preflight at launch time: the port/browser/env may have changed since
  // the banner was printed (e.g. a previous supervised child still holds it).
  const fresh = await preflight({ port: opts.port ?? report.port });
  const errors = fresh.problems.filter(x => x.sev === 'error');
  if (errors.length) {
    process.stdout.write(c(RED, '\n[错误] 前置检查未通过，无法启动守卫：\n'));
    for (const e of errors) process.stdout.write(c(RED, '  - ' + e.message + '  → ' + e.hint) + '\n');
    return;
  }

  process.stdout.write('\n' + c(GRN, '✅ 前置检查通过') + '，即将启动：\n');
  process.stdout.write(launchSummary(fresh).split('\n').map(x => '  ' + x).join('\n') + '\n');

  const proceed = opts.yes || (await ask(c(YEL, '确认启动并接管 dsh web？') + ' (y/N) ')).startsWith('y');
  if (!proceed) { process.stdout.write('已取消。\n'); return }

  let release: (() => void) | undefined;
  try { release = acquireLock(home) }
  catch (e) { process.stdout.write(c(RED, '[错误] ' + String(e instanceof Error ? e.message : e)) + '\n'); return }

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
      process.stdout.write('\n' + c(GRN, '✅ dsh web 已健康启动：' + verdict.url) + '\n');
      process.stdout.write(c(CYN, '守卫正在监控。输入回车返回菜单，或直接关闭本窗口结束。') + '\n');
      await ask('[回车返回菜单] ');
      watchSupervisor(verdict.supervisor, release!);
      return;
    }
    if (verdict.rolledBack) {
      process.stdout.write(c(YEL, '\n[回滚] 已自动回滚到 last-good 配置，正在重启 dsh web…') + '\n');
      const second = await superviseBoot({ ...guardOpts, autoConfirm: true })
      if (second.ok) {
        activeGuard = { supervisor: second.supervisor, release: release! };
        process.stdout.write(c(GRN, '\n✅ 回滚后重启健康：' + second.url) + '\n');
        await ask('[回车返回菜单] ');
        watchSupervisor(second.supervisor, release!);
        return;
      }
      process.stdout.write(c(RED, '\n[错误] 回滚后仍失败（kind=' + second.failureKind + '）。请检查 ' + join(qaqDir(home), 'rolled-back') + ' 中的坏配置。') + '\n');
    } else if (verdict.rollbackCancelled) {
      process.stdout.write(c(YEL, '\n[取消] 你拒绝了回滚，不做自动重启。请检查 ' + join(qaqDir(home), 'rolled-back') + '。') + '\n');
    } else {
      process.stdout.write(c(RED, '\n[失败] 启动失败 kind=' + verdict.failureKind + (verdict.error ? '：' + verdict.error : '') + '。') + '\n');
    }
  } catch (err) {
    process.stdout.write(c(RED, '\n[守卫错误] ' + String(err instanceof Error ? err.message : err)) + '\n');
  } finally {
    // Release the lock only when no supervised child is still running under us.
    if (!activeGuard) release?.();
  }
}

/** The persistent header re-printed after every screen clear. */
function printHeader(report: EnvReport): void {
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '┌──────────────────────────────────────────────┐') + '\n');
  process.stdout.write(c(BOLD, '│   QAQ — DeepSeek Harness 启动容灾守卫控制台    │') + '\n');
  process.stdout.write(c(BOLD, '└──────────────────────────────────────────────┘') + '\n');
  process.stdout.write(launchSummary(report).split('\n').map(x => '  ' + x).join('\n') + '\n');
  if (report.problems.length) process.stdout.write(c(YEL, problemBanner(report)) + '\n');
  process.stdout.write('\n');
}

async function runConsole(home: string, profile: string, opts: ConsoleOpts, ask: (p: string) => Promise<string>): Promise<void> {
  const report = await preflight({ port: opts.port })

  // One screen at a time: clear before every menu so the window never stacks
  // stale menus/output (the header is re-printed each time). No-op on non-TTY.
  const clearScreen = (): void => { if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H') }

  let lastNotice = ''
  let running = true;
  while (running) {
    clearScreen();
    printHeader(report);
    if (activeGuard) process.stdout.write(c(CYN, '🛡 守卫监控中：dsh web 正在后台运行（回车 [1] 会被拒绝，等待其退出即可）') + '\n\n');
    if (lastNotice) process.stdout.write(c(GRN, '✔ ' + lastNotice) + '\n\n');
    process.stdout.write(c(BOLD, '主菜单') + '（profile ' + profile + '）\n');
    process.stdout.write('  ' + c(CYN, '[1]') + ' 一键启动守卫（接管 dsh web）\n');
    process.stdout.write('  ' + c(CYN, '[2]') + ' 查看状态\n');
    process.stdout.write('  ' + c(CYN, '[3]') + ' 手动备份当前配置为 last-good\n');
    process.stdout.write('  ' + c(CYN, '[4]') + ' 手动回滚到 last-good\n');
    process.stdout.write('  ' + c(CYN, '[5]') + ' 重置失败计数\n');
    process.stdout.write('  ' + c(CYN, '[6]') + ' 自动挂载 dsh-qaq 备份插件\n');
    process.stdout.write('  ' + c(CYN, '[7]') + ' 查看日志（error.log / access.log / host.log）\n');
    process.stdout.write('  ' + c(CYN, '[q]') + ' 退出\n');
    const choice = await ask(c(YEL, '请选择: '));
    switch (choice) {
      case '1': case 'l': case 'launch': await runLaunch(home, report, profile, opts, ask); break
      case '2': case 's': case 'status': {
        printState(home, profile);
        await ask('\n[回车返回菜单] ');
        break
      }
      case '3': case 'b': case 'backup': {
        manualBackup(home, profile, new Logger(home));
        lastNotice = '已备份当前配置为 last-good。';
        break
      }
      case '4': case 'r': case 'restore': {
        const state = readState(home);
        const p = profileState(state, profile);
        const good = p.lastGoodSnapshot ? join(qaqDir(home), p.lastGoodSnapshot.startsWith('history/') ? p.lastGoodSnapshot : 'history/' + p.lastGoodSnapshot) : null;
        const usable = good && isUsable(good);
        if (!usable) { lastNotice = '尚无 last-good 快照可用，请先备份或成功启动一次。'; break }
        const confirm = await ask(c(YEL, '确认将 profile 回滚到 last-good？') + ' (y/N) ');
        if (confirm.startsWith('y')) { manualRestore(home, profile, good!, new Logger(home)); lastNotice = '已回滚到 last-good。' }
        else lastNotice = '已取消。';
        break;
      }
      case '5': case 'reset': {
        const state = readState(home); const p = profileState(state, profile);
        p.hostFailures = 0; p.uiFailures = 0; delete p.lastFailure;
        await import('./store.ts').then(m => m.writeState(home, state));
        new Logger(home).access('reset counters via console for profile ' + profile, { profile, action: 'reset' });
        lastNotice = '已清零失败计数。';
        break;
      }
      case '6': case 'i': case 'install': {
        const r = installPlugin(home, profile, new Logger(home));
        lastNotice = r.message;
        break;
      }
      case '7': case 'v': case 'logs': {
        const logDir = join(qaqDir(home), 'log');
        process.stdout.write('\n' + c(BOLD, '—— error.log（最近）——') + '\n');
        tailFile(join(logDir, 'error.log'));
        process.stdout.write('\n' + c(BOLD, '—— access.log（最近）——') + '\n');
        tailFile(join(logDir, 'access.log'));
        process.stdout.write('\n' + c(BOLD, '—— host.log（最近）——') + '\n');
        tailFile(join(logDir, 'host.log'), 3000);
        await ask('\n[回车返回菜单] ');
        break;
      }
      case 'q': case 'quit': case 'exit': running = false; break;
      default: lastNotice = '未知选项，请重试。';
    }
  }
  clearScreen();
  printHeader(report);
  process.stdout.write(c(BOLD, '守卫控制台已退出。有问题请查看 ' + join(qaqDir(home), 'log') + ' 目录，或查看 README。') + '\n');
}

/** Entry point: open the interactive console. */
export async function openConsole(profile = 'web', opts: ConsoleOpts = {}): Promise<void> {
  const home = resolveDshHome();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = createAsker(rl);
  rl.on('SIGINT', () => {
    // Kill a supervised child so a Ctrl+C never leaves dsh web holding the port.
    if (activeGuard) { try { activeGuard.supervisor.kill() } catch { /* ignore */ } }
    process.stdout.write('\n(caught Ctrl+C\n');
    rl.close();
    process.exit(130);
  });
  await runConsole(home, profile, opts, ask);
  rl.close();
}
