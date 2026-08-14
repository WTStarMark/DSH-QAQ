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
  /** Custom readiness check once the port accepts a connection. */
  isReady?: (port: number) => Promise<boolean>
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

function defaultReady(port: number): Promise<boolean> {
  return new Promise((isReady) => {
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); isReady(true) })
      socket.once('error', () => { socket.destroy(); setTimeout(attempt, 300) })
    }
    attempt()
  })
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
    child.stdout?.on('data', (d) => boundedPush(String(d)))
    child.stderr?.on('data', (d) => boundedPush(String(d)))
  }

  let exitResolve!: (code: number | null) => void
  const exit = new Promise<number | null>((r) => { exitResolve = r })
  child.on('exit', (code) => exitResolve(code ?? null))
  child.on('error', (err) => { boundedPush('spawn error: ' + err.message); exitResolve(-1) })

  const hasHostFailureMarker = (): boolean => {
    const text = chunks.join('')
    return HOST_FAIL_KEYWORDS.some(k => text.includes(k))
  }

  const isReady = opts.isReady ?? defaultReady
  const timeout = new Promise<boolean>((_, rej) => {
    setTimeout(() => rej(new Error('host did not open port ' + opts.port + ' within ' + opts.portTimeoutMs + 'ms')), opts.portTimeoutMs)
  })
  const ready = Promise.race([isReady(opts.port), timeout]).then(async (ok) => {
    // Heuristic: if the process exited before the port opened AND a fail marker
    // or non-zero exit occurred, treat as not ready.
    if (!ok) return false
    return true
  })

  return { child, ready, exit, output: () => chunks.join(''), hasHostFailureMarker, kill: () => { try { child.kill() } catch { /* ignore */ } } }
}
