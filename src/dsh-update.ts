/**
 * qaq-dsh-update — source-level, lossless DSH update for a git source checkout.
 *
 * The flow (mirrors the design documented in the analysis):
 *   plan (read-only preflight + snapshot) → switch (git) → install → build →
 *   verify → done | rolled-back. Every stage's side effects are backed up
 *   BEFORE they run, and any failure after the switch rolls the checkout back
 *   to the recorded HEAD ref (a `git checkout --force` never touches ignored
 *   files: node_modules/, .env, .sessions/, .storages/, … are preserved by git
 *   semantics; the flow NEVER runs `git clean`).
 *
 * Safety contract (hard constraints):
 *   - Works ONLY on a git checkout (isGitCheckout). PATH/npm installs get an
 *     explicit "source-level update unavailable" refusal, never a silent no-op.
 *   - Refuses when a DSH process is detected up (plugin heartbeat or busy
 *     port) — planning never fires processes; apply refuses at plan time.
 *   - Only tracked files are touched by git ops; local tracked modifications
 *     are archived as diffs into the backup dir, then stashed so the checkout
 *     can move. The stash is popped if the checkout itself fails.
 *   - Untracked/ignored data (`.env`, `.sessions/`, `.storages/`, node_modules)
 *     is never deleted: no `git clean`, no rm of ignored paths.
 *   - No DSH process is spawned by plan/apply (no supervised restart here — the
 *     caller decides when to boot the new version with the guard).
 *
 * Everything network/exec is injectable (fetch / git / cmd) so the machine is
 * unit-testable offline with fakes.
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { compareSemver } from './update.ts'
import { readCheckoutVersion } from './dsh-version.ts'
import { qaqDir } from './paths.ts'
import { readPluginHeartbeat } from './shared-io.ts'
import { isPortFree } from './env.ts'

/** The GitHub repo whose dsh-vX tags are the update source. */
export const DSH_UPDATE_REPO = 'deepseek-ai/deepseek-harness'
/** Git tag prefix for DSH releases (`dsh-v0.1.1-rc.1`). */
export const DSH_TAG_PREFIX = 'dsh-v'
/** Public GitHub tags API (no auth needed for public repos). */
export const DSH_TAGS_API_URL = 'https://api.github.com/repos/' + DSH_UPDATE_REPO + '/tags'
/** Network timeout for the remote tag check (ms). */
export const DSH_UPDATE_TIMEOUT_MS = 10000

export interface GitResult { ok: boolean; code: number; stdout: string; stderr: string }
export interface CmdResult extends GitResult {}
/** Async git runner over a checkout. */
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
/** Async long-running command runner (pnpm install/build), with optional line
 *  progress callback. */
export type Cmd = (cwd: string, args: string[], onLine?: (line: string) => void) => Promise<CmdResult>

/** Default git runner: execFile (no shell — plain argv, safe). */
export const defaultGit: Git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, {
      cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1
        resolve({ ok: false, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err.message ? '\n' + err.message : '') })
      } else resolve({ ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })

/** Default command runner: spawn; on Windows use the shell so pnpm/npx .cmd
 *  shims resolve (mirrors setup.ts). Output streams to onLine + is collected. */
export const defaultCmd: Cmd = (cwd, args, onLine) =>
  new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd, shell: process.platform === 'win32', windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const feed = (buf: Buffer, into: (s: string) => void): void => {
      const s = buf.toString('utf8')
      into(s)
      if (onLine) onLine(s.trimEnd())
    }
    child.stdout?.on('data', (d: Buffer) => feed(d, (s) => { stdout += s }))
    child.stderr?.on('data', (d: Buffer) => feed(d, (s) => { stderr += s }))
    child.on('error', (err) => resolve({ ok: false, code: 1, stdout, stderr: stderr + (err.message ?? '') }))
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 1, stdout, stderr }))
  })

/** True when `checkout` is a git work tree (.git dir or gitfile). */
export function isGitCheckout(checkout: string): boolean {
  try { const st = statSync(join(checkout, '.git')); return st.isDirectory() || st.isFile() } catch { return false }
}

/** Parse `git status --porcelain` into tracked-modified and untracked paths. */
export function parseStatusPorcelain(out: string): { modified: string[]; untracked: string[] } {
  const modified: string[] = []
  const untracked: string[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    const code = line.slice(0, 2)
    const path = line.slice(3)
    if (code === '??' || code === '!!') { untracked.push(path); continue }
    if (/[MADRCU]/.test(code[0] ?? '') || /[MADRCU]/.test(code[1] ?? '')) modified.push(path)
  }
  return { modified, untracked }
}

/** Version part of a tag with the given prefix (`dsh-v0.1.1-rc.1` →
 *  `0.1.1-rc.1`); null when foreign. */
export function tagVersion(tag: string, prefix: string = DSH_TAG_PREFIX): string | null {
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : null
}

/** The latest release tag over a list of GitHub tag entries (JSON array of
 *  {name, ...}). Chooses by full semver; non-matching tags are ignored. */
export function pickLatestDshTag(entries: { name?: string }[], prefix: string = DSH_TAG_PREFIX): string | null {
  let best: string | null = null
  for (const e of entries) {
    const name = typeof e?.name === 'string' ? e.name : ''
    const ver = tagVersion(name, prefix)
    if (!ver) continue
    if (best === null) { best = name; continue }
    const bv = tagVersion(best, prefix) ?? '0.0.0'
    if (compareSemver(ver, bv) > 0) best = name
  }
  return best
}

export interface FetchDshLatestOptions {
  /** fetch implementation (default: global fetch). */
  fetchImpl?: typeof fetch
  /** Request timeout in ms (default DSH_UPDATE_TIMEOUT_MS). */
  timeoutMs?: number
  /** Tags API URL (default DSH_TAGS_API_URL). */
  url?: string
  /** Tag prefix filter (default DSH_TAG_PREFIX). */
  tagPrefix?: string
}

export interface DshLatestResult {
  ok: boolean
  /** The newest release tag (e.g. `dsh-v0.1.1-rc.1`), null when none found. */
  tag: string | null
  /** The newest release version (tag minus the prefix), null when none found. */
  version: string | null
  error?: string
}

/** Ask GitHub for the newest `dsh-vX` tag. Never throws. */
export async function fetchDshLatestTag(opts: FetchDshLatestOptions = {}): Promise<DshLatestResult> {
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const timeoutMs = opts.timeoutMs ?? DSH_UPDATE_TIMEOUT_MS
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try { res = await doFetch(opts.url ?? DSH_TAGS_API_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } }) }
    finally { clearTimeout(timer) }
    if (!res.ok) return { ok: false, tag: null, version: null, error: 'HTTP ' + res.status }
    const json = await res.json() as { name?: string }[]
    if (!Array.isArray(json)) return { ok: false, tag: null, version: null, error: 'unexpected payload' }
    const tag = pickLatestDshTag(json, opts.tagPrefix ?? DSH_TAG_PREFIX)
    if (!tag) return { ok: false, tag: null, version: null, error: 'no dsh-vX tag found' }
    return { ok: true, tag, version: tagVersion(tag, opts.tagPrefix ?? DSH_TAG_PREFIX) }
  } catch (err) {
    return { ok: false, tag: null, version: null, error: String(err instanceof Error ? err.message : err) }
  }
}

export interface DshUpdateCheckOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  url?: string
  /** Local DSH version override (else read from checkout). */
  version?: string | null
  /** DSH source checkout to read the local version from. */
  checkout?: string | null
}

export interface DshUpdateCheckResult {
  ok: boolean
  current: string | null
  latestTag: string | null
  latestVersion: string | null
  updateAvailable: boolean
  error?: string
}

/** Check whether a newer DSH release exists (GitHub tags vs. the managed
 *  checkout's version). Never throws. */
export async function checkDshUpdate(opts: DshUpdateCheckOptions = {}): Promise<DshUpdateCheckResult> {
  const current = opts.version !== undefined && opts.version !== null
    ? opts.version
    : (opts.checkout ? readCheckoutVersion(opts.checkout) : null)
  const remote = await fetchDshLatestTag({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, url: opts.url })
  if (!remote.ok || !remote.tag || !remote.version) {
    return { ok: false, current, latestTag: null, latestVersion: null, updateAvailable: false, error: remote.error ?? 'remote check failed' }
  }
  const updateAvailable = current !== null && compareSemver(remote.version, current) > 0
  return { ok: true, current, latestTag: remote.tag, latestVersion: remote.version, updateAvailable }
}

/** Default "is a DSH process up" probe: fresh plugin heartbeat (the dsh-qaq
 *  in-process presence channel) OR the web port busy. Never touches processes;
 *  a busy port only makes the updater refuse (safe direction). */
export async function defaultIsDshRunning(home: string, port = 3080): Promise<boolean> {
  try {
    const hb = readPluginHeartbeat(home, 15000)
    if (hb && typeof hb.pid === 'number' && hb.pid > 0) return true
  } catch { /* fall through to the port probe */ }
  try { return !(await isPortFree(port, 2500)) } catch { return true }
}

/** Sanitized timestamp for backup dir names/output files (ISO without ':'). */
export function updateTimestamp(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** A file-name-safe flattening of a repo-relative path (for .diff archives). */
export function sanitizeFilePart(path: string): string {
  return path.replace(/[^0-9A-Za-z._-]+/g, '_')
}

/* ============================== plan ====================================== */

export interface DshUpdatePlanOptions {
  home: string
  profile: string
  checkout: string
  targetTag: string
  /** Backup dir for the pre-switch snapshot (default: <home>/.qaq/update/backup-<ts>). */
  backupDir?: string
  git?: Git
  isDshRunning?: () => Promise<boolean>
  versionOf?: (checkout: string) => string | null
  /** Port used by the default running-DSH probe. */
  port?: number
}

export interface DshUpdatePlan {
  ok: boolean
  /** Human-readable refusal/error when !ok. */
  reason?: string
  checkout: string
  currentVersion: string | null
  currentRef: string | null
  currentBranch: string | null
  targetTag: string
  targetVersion: string | null
  backupDir?: string
  modified: string[]
  untracked: string[]
  /** Number of archived files written to the backup dir. */
  archiveFiles: number
}

const EMPTY_STATUS = { modified: [] as string[], untracked: [] as string[] }

/** Stage 0+1: read-only preflight + lossless snapshot. Never mutates the
 *  checkout (git rev-parse/status/diff are pure); only writes the backup dir
 *  under <home>/.qaq/update/. */
export async function planDshUpdate(opts: DshUpdatePlanOptions): Promise<DshUpdatePlan> {
  const { home, checkout, targetTag } = opts
  const git = opts.git ?? defaultGit
  const versionOf = opts.versionOf ?? readCheckoutVersion
  const targetVersion = tagVersion(targetTag)
  const fail = (reason: string): DshUpdatePlan => ({
    ok: false, reason, checkout, currentVersion: null, currentRef: null, currentBranch: null,
    targetTag, targetVersion, modified: EMPTY_STATUS.modified, untracked: EMPTY_STATUS.untracked, archiveFiles: 0,
  })

  if (!targetTag) return fail('target tag is empty')
  if (!isGitCheckout(checkout)) return fail('not a git checkout: ' + checkout)
  const runningProbe = opts.isDshRunning ?? (() => defaultIsDshRunning(home, opts.port ?? 3080))
  if (await runningProbe()) return fail('DSH is currently running — stop it before updating')
  if (!targetVersion) return fail('tag has no dsh version: ' + targetTag)

  const tagExists = await git(checkout, ['rev-parse', '-q', '--verify', 'refs/tags/' + targetTag])
  if (!tagExists.ok) return fail('tag ' + targetTag + ' not present locally — fetch it first (git fetch origin tag ' + targetTag + ')')

  const ref = await git(checkout, ['rev-parse', 'HEAD'])
  const branch = await git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await git(checkout, ['status', '--porcelain'])
  const currentVersion = versionOf(checkout)
  const parsed = parseStatusPorcelain(status.stdout)

  // Lossless snapshot into the backup dir (qaqDir(home)/update/backup-<ts>).
  const backupDir = opts.backupDir ?? join(qaqDir(home), 'update', 'backup-' + updateTimestamp())
  let archiveFiles = 0
  try {
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'plan.json'), JSON.stringify({
      ts: updateTimestamp(), kind: 'dsh-update-plan', profile: opts.profile,
      currentVersion, currentRef: ref.ok ? ref.stdout.trim() : null, currentBranch: branch.ok ? branch.stdout.trim() : null,
      targetTag, targetVersion, modified: parsed.modified, untracked: parsed.untracked,
    }, null, 2) + '\n', 'utf8')
    archiveFiles++
    writeFileSync(join(backupDir, 'status.txt'), status.stdout, 'utf8')
    archiveFiles++
    const changesDir = join(backupDir, 'changes')
    mkdirSync(changesDir, { recursive: true })
    for (const [i, p] of parsed.modified.entries()) {
      const diff = await git(checkout, ['diff', '--', p])
      if (diff.ok && diff.stdout) {
        writeFileSync(join(changesDir, String(i + 1) + '-' + sanitizeFilePart(basename(p)) + '.diff'), diff.stdout, 'utf8')
        archiveFiles++
      }
    }
  } catch (err) {
    return fail('backup snapshot failed: ' + String(err instanceof Error ? err.message : err))
  }

  return {
    ok: true, checkout, currentVersion,
    currentRef: ref.ok ? ref.stdout.trim() : null,
    currentBranch: branch.ok ? branch.stdout.trim() : null,
    targetTag, targetVersion, backupDir,
    modified: parsed.modified, untracked: parsed.untracked, archiveFiles,
  }
}

/* ============================= apply ====================================== */

export type DshUpdateStage =
  | 'switch' | 'install' | 'build' | 'verify' | 'done'
  | 'rolled-back' | 'failed'

export interface DshUpdateApplyOptions {
  plan: DshUpdatePlan
  /** Auto-rollback on any failure after the switch (default true). */
  autoRollback?: boolean
  /** Called as each stage runs (for progress UI). */
  onStage?: (stage: DshUpdateStage, detail?: string) => void
  /** Raw output lines from install/build. */
  onLine?: (line: string) => void
  git?: Git
  cmd?: Cmd
  installArgs?: string[]
  buildArgs?: string[]
  /** Retry install WITHOUT --frozen-lockfile on frozen failure. Default false:
   *  the conservative, lossless choice (never silently mutate the lockfile). */
  retryInstallWithoutFrozen?: boolean
  /** On rollback, re-run `pnpm install --frozen-lockfile` to re-align
   *  node_modules with the restored old lockfile. Default true. */
  restoreDepsOnRollback?: boolean
  versionOf?: (checkout: string) => string | null
}

export interface DshUpdateOutcome {
  ok: boolean
  stage: DshUpdateStage
  finalVersion: string | null
  rolledBack: boolean
  /** Primary failure detail when !ok. */
  detail?: string
  /** Ordered audit lines (also surfaced via onLine). */
  log: string[]
}

/** Stage 2-6: switch → install → build → verify, with lossless auto-rollback.
 *  Never spawns a DSH process; the caller decides how/when to boot the new
 *  version under the guard. */
export async function applyDshUpdate(opts: DshUpdateApplyOptions): Promise<DshUpdateOutcome> {
  const plan = opts.plan
  const git = opts.git ?? defaultGit
  const cmd = opts.cmd ?? defaultCmd
  const versionOf = opts.versionOf ?? readCheckoutVersion
  const log: string[] = []
  const note = (m: string): void => { log.push(m); opts.onLine?.(m) }

  let currentStage: DshUpdateStage = 'switch'
  const stage = (s: DshUpdateStage, detail?: string): void => { currentStage = s; opts.onStage?.(s, detail) }

  const rollback = async (detail: string): Promise<DshUpdateOutcome> => {
    note('failure: ' + detail)
    if (opts.autoRollback !== false) {
      stage('rolled-back', detail)
      note('rollback: restoring ' + (plan.currentRef ?? 'previous commit'))
      if (plan.currentRef) await git(plan.checkout, ['checkout', '--force', plan.currentRef])
      if (opts.restoreDepsOnRollback !== false) {
        note('rollback: pnpm install --frozen-lockfile (re-align node_modules)')
        await cmd(plan.checkout, ['install', '--frozen-lockfile'])
      }
      const v = versionOf(plan.checkout)
      note('rollback: restored version ' + (v ?? 'unknown'))
    }
    return { ok: false, stage: 'rolled-back', finalVersion: null, rolledBack: true, detail, log }
  }

  // ---- switch ----
  stage('switch')
  let stashCreated = false
  if (plan.modified.length > 0) {
    const stash = await git(plan.checkout, ['stash', 'push', '-m', 'qaq-dsh-update ' + plan.targetTag, '--', ...plan.modified])
    stashCreated = stash.ok
    note(stash.ok
      ? 'stashed ' + plan.modified.length + ' modified file(s) (diffs archived in ' + plan.backupDir + ')'
      : 'stash push failed: ' + stash.stderr.trim())
  }
  const co = await git(plan.checkout, ['checkout', plan.targetTag])
  if (!co.ok) {
    if (stashCreated) await git(plan.checkout, ['stash', 'pop'])
    return rollback('git checkout ' + plan.targetTag + ' failed: ' + co.stderr.trim())
  }
  note('switched to ' + plan.targetTag + (stashCreated ? ' (local changes stashed)' : ''))

  // ---- install ----
  stage('install')
  const installArgs = opts.installArgs ?? ['install', '--frozen-lockfile']
  let inst = await cmd(plan.checkout, installArgs, opts.onLine)
  if (!inst.ok && opts.retryInstallWithoutFrozen === true && installArgs.includes('--frozen-lockfile')) {
    note('frozen-lockfile install failed — retrying plain pnpm install (lockfile MAY change)')
    inst = await cmd(plan.checkout, ['install'], opts.onLine)
  }
  if (!inst.ok) return rollback('pnpm install failed: ' + (inst.stderr.trim().slice(0, 400) || 'exit ' + inst.code))

  // ---- build ----
  stage('build')
  const bld = await cmd(plan.checkout, opts.buildArgs ?? ['build'], opts.onLine)
  if (!bld.ok) return rollback('pnpm build failed: ' + (bld.stderr.trim().slice(0, 400) || 'exit ' + bld.code))

  // ---- verify ----
  stage('verify')
  const v = versionOf(plan.checkout)
  const okVer = v !== null && plan.targetVersion !== null && compareSemver(v, plan.targetVersion) === 0
  if (!okVer) return rollback('version mismatch after update: got ' + (v ?? 'unknown') + ', expected ' + plan.targetVersion)

  stage('done')
  note('DSH updated to ' + v)
  return { ok: true, stage: 'done', finalVersion: v, rolledBack: false, log }
}
