/**
 * Spawn and supervise the `dsh web` process. Inherits env/DSH_HOME/cwd, streams
 * output to the current stdio (a visible CMD window when launched that way),
 * and reports exit code + readiness.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

/** Strings in host output that indicate a host-side boot failure (fail loud). */
const HOST_FAIL_KEYWORDS = [
  'plugin tree failed to load',
  'failed to load plugin',
  'cannot get property',
  'unhandled exception',
]

export interface DshSpawnOptions {
  /** Command parts, e.g. ['dsh','web'] or ['node','--import','tsx/esm','apps/cli/src/bin.ts','web']. */
  command: string[]
  cwd: string
  /** Extra env; DSH_HOME override. */
  env?: Record<string, string | undefined>
  port: number
  portTimeoutMs: number
  /** Attach child stdio to the current process (a visible CMD window). Default true. */
  attachStdio?: boolean
  /** Called with each captured chunk (only when attachStdio is false). */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

export interface DshSupervisor {
  child: ChildProcess
  /** Resolves true once the port is up; rejects on timeout or early host failure. */
  ready: Promise<boolean>
  /** Resolves with the exit code (or null if we killed it). */
  exit: Promise<number | null>
  /** Bounded combined output. */
  output: () => string
  /** Whether any host fail-loud keyword appeared in output. */
  hasHostFailureMarker: () => boolean
  kill: () => void
}

/**
 * Spawn dsh web and monitor it.
 */
export function spawnDsh(opts: DshSpawnOptions): DshSupervisor {
  const chunks: string[] = []
  const boundedPush = (s: string): void => {
    chunks.push(s)
    let total = 0
    for (let i = chunks.length - 1; i >= 0; i--) { total += chunks[i].length; if (total > 64_000) { chunks.splice(0, i); break } }
  }

  const child = spawn(opts.command[0], opts.command.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: opts.attachStdio === false ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: false,
  })

  if (opts.attachStdio === false) {
    child.stdout?.on('data', (d) => { boundedPush(String(d)); opts.onOutput?.(String(d), 'stdout') })
    child.stderr?.on('data', (d) => { boundedPush(String(d)); opts.onOutput?.(String(d), 'stderr') })
  }

  let exitResolve!: (code: number | null) => void
  const exit = new Promise<number | null>((r) => { exitResolve = r })
  child.on('exit', (code) => exitResolve(code ?? null))
  child.on('error', (err) => { boundedPush('spawn error: ' + err.message); exitResolve(-1) })

  const hasHostFailureMarker = (): boolean => {
    // Case-insensitive: host log phrasing may vary (e.g. "Failed to load" vs "failed to load").
    const text = chunks.join('').toLowerCase()
    return HOST_FAIL_KEYWORDS.some(k => text.includes(k.toLowerCase()))
  }

  // Readiness: the port must open AND the child must survive a short grace
  // window. A child that exits before the port opens (or right after — e.g. a
  // bind EADDRINUSE caused by a foreign process already holding the port) is a
  // host failure reported immediately, instead of being mistaken for a ready
  // host or silently waiting out the full timeout.
  let settleReady!: (v: boolean) => void
  let failReady!: (e: Error) => void
  const ready = new Promise<boolean>((res, rej) => { settleReady = res; failReady = rej })
  let settled = false
  const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
  const timer = setTimeout(() => finish(() => failReady(new Error('host did not open port ' + opts.port + ' within ' + opts.portTimeoutMs + 'ms'))), opts.portTimeoutMs)

  child.once('exit', (code) => {
    const marker = hasHostFailureMarker()
    finish(() => failReady(new Error('host exited before ready (code=' + code + ')' + (marker ? '; fail-loud marker in output' : ''))))
  })
  child.once('error', (err) => {
    finish(() => failReady(new Error('failed to spawn host: ' + err.message)))
  })

  const probe = (): void => {
    if (settled) return
    const socket = net.connect({ host: '127.0.0.1', port: opts.port })
    socket.once('connect', () => {
      socket.destroy()
      // Grace window: prove the child is not about to crash right after opening
      // the port (covers a bind EADDRINUSE from a foreign port holder).
      setTimeout(() => finish(() => settleReady(true)), 300)
    })
    socket.once('error', () => { socket.destroy(); setTimeout(probe, 300) })
  }
  probe()

  return { child, ready, exit, output: () => chunks.join(''), hasHostFailureMarker, kill: () => { try { child.kill() } catch { /* ignore */ } } }
}