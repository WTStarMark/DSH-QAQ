/**
 * qaq-dsh-version — resolve the REAL DeepSeek Harness version of the
 * installation QAQ manages (the same installation `dsh-context.ts` locates).
 *
 * Sources, in order:
 *  1. `checkout` — the DSH source-checkout root: its root package.json
 *     version (the workspace shares one version across root + apps + packages).
 *     Both apps/cli's checked-in bin (bin.ts readVersion) and the root manifest
 *     read the same file, so no child process is needed for the source layout.
 *  2. `command` — an executable to run `dsh --version` (PATH / npm-global
 *     installs). `--version` only prints and exits (commander), it never boots
 *     a profile, so it does not touch a running DSH.
 *
 * Version strings are compared with the FULL semver rules used by DSH's own
 * release tooling (scripts/release/bump.ts — see compareSemver in update.ts):
 * `0.1.0-rc.10 > 0.1.0-rc.9`, and any `-rc.N` prerelease ranks BELOW the
 * release it precedes (`0.1.1-rc.1 < 0.1.1`). QAQ's plain-triple
 * compareVersions cannot see rc ordering and would report a false
 * "up-to-date" between two rcs of the same release.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

/** Read the DSH version from a checkout root manifest. Null when absent. */
export function readCheckoutVersion(checkout: string): string | null {
  try {
    const pj = join(checkout, 'package.json')
    if (!existsSync(pj)) return null
    const v = (JSON.parse(readFileSync(pj, 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : null
  } catch { return null }
}

export interface ResolveDshVersionOptions {
  /** DSH source-checkout root (read its manifest — no exec). */
  checkout?: string | null
  /** Executable to run `dsh --version` (PATH / npm installs). Used only when
   *  `allowExec` is true. */
  command?: string[] | null
  /** Working directory for the version exec (the checkout root). */
  cwd?: string
  /** Permit the `dsh --version` exec. Off by default so imports never spawn a
   *  process unless the caller explicitly opts in (CLI). */
  allowExec?: boolean
  /** Exec implementation (injectable for tests). Default: execFile. */
  execImpl?: (cmd: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<{ ok: boolean; stdout: string }>
}

export interface DshVersionInfo {
  version: string | null
  /** Where the version came from. */
  source: 'checkout' | 'command' | 'none'
}

/** Default version exec: `execFile`, shell only on Windows (npm .cmd shims). */
export const defaultVersionExec = (cmd: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      shell: process.platform === 'win32',
      timeout: opts.timeoutMs ?? 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) resolve({ ok: false, stdout: '' })
      else resolve({ ok: true, stdout: String(stdout ?? '') })
    })
  })

/** Pull the first x.y.z[-pre] token out of command output (e.g. `dsh --version`). */
export function extractVersionFromOutput(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout)
  return m ? m[1] : null
}

/** Resolve the DSH version for the managed installation. Never throws. */
export async function resolveDshVersion(opts: ResolveDshVersionOptions = {}): Promise<DshVersionInfo> {
  if (opts.checkout) {
    const v = readCheckoutVersion(opts.checkout)
    if (v) return { version: v, source: 'checkout' }
  }
  if (opts.allowExec && opts.command && opts.command.length > 0) {
    try {
      const exec = opts.execImpl ?? defaultVersionExec
      const r = await exec(opts.command, { cwd: opts.cwd, timeoutMs: 10000 })
      if (r.ok) {
        const v = extractVersionFromOutput(r.stdout)
        if (v) return { version: v, source: 'command' }
      }
    } catch { /* fall through to none */ }
  }
  return { version: null, source: 'none' }
}

/** Best-effort synchronous resolution for display paths where spawn is not
 *  wanted (TUI header): checkout manifest only. */
export function resolveDshVersionSync(checkout?: string | null): string | null {
  return checkout ? readCheckoutVersion(checkout) : null
}
