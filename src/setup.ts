/**
 * qaq setup — install dependencies and build the QAQ bundle from the command
 * line (cross-platform replacement for the deleted bin/qaq-install*.cmd
 * one-click installers). Runs pnpm (with an npm/corepack fallback), then
 * `pnpm build` to emit dist/qaq.mjs + regenerate the plugin lib.
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

/** Detect whether pnpm is available on PATH. */
function hasPnpm(): boolean {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { stdio: 'ignore' }); return true }
  catch { return false }
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

    if (!existsSync(join(root, 'node_modules'))) {
      if (hasPnpm()) {
        sh('pnpm', ['install']); steps.push('pnpm install')
      } else {
        // corepack/npx fallback
        sh('npx', ['-y', 'pnpm@11', 'install']); steps.push('pnpm install (via npx)')
      }
    } else {
      steps.push('node_modules present (skipped install)')
    }

    sh('pnpm', ['build']); steps.push('pnpm build')
    ok = true
  } catch (e) {
    ok = false
    error = e instanceof Error ? e.message : String(e)
  }
  return { ok, steps, error }
}
