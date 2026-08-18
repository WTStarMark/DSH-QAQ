/**
 * qaq setup — install dependencies and build the QAQ bundle from the command
 * line (cross-platform replacement for the deleted bin/qaq-install*.cmd
 * one-click installers). Runs pnpm >= 11 (with an `npx pnpm@11` fallback when
 * pnpm is missing or too old), then `pnpm build` to emit dist/qaq.mjs +
 * regenerate the plugin lib.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repo root (this file lives in src/, so root is one level up).
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeMajor = Number(/^v?(\d+)/.exec(process.version)?.[1] ?? 0)

export interface SetupResult { ok: boolean; steps: string[]; error?: string }

/** Run a command and return its stdout; throws (string) on non-zero exit. */
function sh(cmd: string, args: string[]): string {
  // On Windows, pnpm/npx resolve via .cmd shims that raw execFileSync can't
  // run (ENOENT) — delegate to the shell there, exactly like tools/smoke.mjs.
  try {
    return execFileSync(cmd, args, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      shell: process.platform === 'win32',
    })
  } catch (e) {
    const msg = (e as { stderr?: Buffer | string; message?: string }).stderr
      ? String((e as { stderr: Buffer | string }).stderr).slice(0, 800)
      : String((e as Error).message ?? e)
    throw new Error(cmd + ' ' + args.join(' ') + ' failed: ' + msg)
  }
}

/**
 * Detect the local pnpm major version, or null when pnpm is missing/unusable.
 */
function pnpmMajorVersion(): number | null {
  try {
    const v = sh('pnpm', ['--version']).trim()
    const m = /^v?(\d+)/.exec(v)
    return m ? Number(m[1]) : null
  } catch { return null }
}

/**
 * Perform a full setup: check node, install dependencies, and build.
 * @param installOnly  when true, only dependency-install (no build) — not used
 *                     yet, kept for symmetry.
 */
export function runSetup(_installOnly = false): SetupResult {
  const steps: string[] = []
  let ok = true
  let error: string | undefined
  try {
    if (nodeMajor < 22) { throw new Error('Node.js >= 22 is required (found v' + process.version + ')') }
    steps.push('node ' + process.version)

    // The workspace pins pnpm@11 (packageManager + the `allowBuilds` key in
    // pnpm-workspace.yaml). A local pnpm 10 would ignore `allowBuilds`, block
    // esbuild's postinstall, and leave a silently broken install — so fall
    // back to `npx pnpm@11` when the local pnpm is missing or older than 11.
    const major = pnpmMajorVersion()
    const useNpxFallback = major === null || major < 11
    if (useNpxFallback) {
      steps.push('pnpm ' + (major === null ? 'not found' : major + ' too old (need >= 11)') + ' — using npx pnpm@11')
    } else {
      steps.push('pnpm ' + major)
    }
    // One package-manager choice drives both install and build.
    const run = (args: string[]): void => {
      if (useNpxFallback) sh('npx', ['-y', 'pnpm@11', ...args])
      else sh('pnpm', args)
    }

    if (!existsSync(join(root, 'node_modules'))) {
      run(['install']); steps.push('pnpm install')
    } else {
      steps.push('node_modules present (skipped install)')
    }

    run(['build']); steps.push('pnpm build')
    ok = true
  } catch (e) {
    ok = false
    error = e instanceof Error ? e.message : String(e)
  }
  return { ok, steps, error }
}
