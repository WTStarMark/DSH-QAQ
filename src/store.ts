/**
 * QAQ state store: state.json read/write, snapshot directory management, and a
 * simple cross-process advisory lock. All writes are atomic (temp file + rename)
 * so a crash never leaves a half-written state or snapshot.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { qaqDir, profileDir } from './paths.ts'

/** One recorded failure of a given kind. */
export interface FailureRecord {
  kind: 'host' | 'ui'
  ts: string
  error: string
  /** Whether this failure was the one that triggered a rollback. */
  triggeredRollback?: boolean
}

/** Per-profile guard state. */
export interface ProfileState {
  hostFailures: number
  uiFailures: number
  lastSuccess?: string
  lastFailure?: FailureRecord
  lastGoodSnapshot?: string
  /** True from the moment a rollback ran until the next successful boot ("anti-loop fence"). */
  rolledBackAt?: string
}

/** The persisted guard state file. */
export interface QaqState {
  version: 1
  profiles: Record<string, ProfileState>
  config: {
    autoConfirm: boolean
  }
}

/** Files that make up one configuration snapshot. */
export type SnapshotFile = 'package.json' | 'cordis.patch.yml' | 'settings.yaml'

const STATE_FILENAME = 'state.json'

/** Create the qaq state root if needed. */
export function ensureQaqDir(home: string): string {
  const dir = qaqDir(home)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A PID-aware advisory lock file used to serialize two guard instances. */
function lockPath(home: string): string { return join(qaqDir(home), '.guard.lock') }

/**
 * Acquire the guard lock (exclusive). A lock whose recorded PID is not alive is
 * treated as stale and reclaimed, so a crashed guard does not permanently block
 * the next run.
 * @returns a release function.
 * @throws if another live guard instance holds the lock.
 */
export function acquireLock(home: string): () => void {
  const lp = lockPath(home)
  try {
    if (existsSync(lp)) {
      const raw = readFileSync(lp, 'utf8')
      const pid = Number(raw.trim())
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
        throw new Error('another qaq guard instance (pid ' + pid + ') is already running; stop it, or remove ' + lp)
      }
      // stale lock: owner pid is not alive — reclaim.
      try { rmSync(lp, { force: true }) } catch { /* best effort */ }
    }
  } catch (err) {
    if (err instanceof Error && /another qaq guard/.test(err.message)) throw err
  }
  writeFileSync(lp, String(process.pid), 'utf8')
  return () => { try { rmSync(lp, { force: true }) } catch { /* best effort */ } }
}

/** Best-effort liveness check for a pid (Windows + POSIX). */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) {
    // EPERM => alive but not ours; ESRCH => dead.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

/** Default empty state. */
export function emptyState(autoConfirm = false): QaqState {
  return { version: 1, profiles: {}, config: { autoConfirm } }
}

/** Read state.json, returning the default when absent or corrupt. */
export function readState(home: string): QaqState {
  const path = join(qaqDir(home), STATE_FILENAME)
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as QaqState
    if (parsed?.version !== 1 || typeof parsed.profiles !== 'object' || parsed.profiles === null) {
      throw new Error('unexpected state schema')
    }
    return {
      version: 1,
      profiles: parsed.profiles,
      config: { autoConfirm: parsed.config?.autoConfirm ?? false },
    }
  } catch {
    return emptyState()
  }
}

/** Atomic JSON write of state.json. */
export function writeState(home: string, state: QaqState): void {
  ensureQaqDir(home)
  const path = join(qaqDir(home), STATE_FILENAME)
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** Get (creating if needed) a profile's state record. */
export function profileState(state: QaqState, profile: string): ProfileState {
  let p = state.profiles[profile]
  if (!p) {
    p = { hostFailures: 0, uiFailures: 0 }
    state.profiles[profile] = p
  }
  return p
}

/** Snapshot the given list of source paths (profile package.json + patch) into a snapshot dir. */
export function writeSnapshot(home: string, snapDir: string, sources: { packageJson: string; patchYml: string | null }): void {
  mkdirSync(snapDir, { recursive: true })
  copyFileSync(sources.packageJson, join(snapDir, 'package.json'))
  if (sources.patchYml && existsSync(sources.patchYml)) {
    copyFileSync(sources.patchYml, join(snapDir, 'cordis.patch.yml'))
  }
  writeFileSync(join(snapDir, 'manifest.json'), JSON.stringify({
    profile: basename(join(snapDir, '../../..')),
    ts: new Date().toISOString(),
  }, null, 2), 'utf8')
}

/** List snapshot directories (history/, rolled-back/) newest-first; only valid snapshot dirs (have manifest.json). */
export function listSnapshots(home: string, sub: string): string[] {
  const base = join(qaqDir(home), sub)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(n => join(base, n))
    .filter(d => existsSync(join(d, 'manifest.json')))
    // ISO timestamps sort lexicographically == chronologically; determinism across restart.
    .sort((a, b) => (basename(b) < basename(a) ? -1 : basename(b) > basename(a) ? 1 : 0))
}

/** Prune history/ to at most `keep` newest snapshots. */
export function pruneSnapshots(home: string, sub: string, keep: number): void {
  const snapshots = listSnapshots(home, sub)
  for (const dir of snapshots.slice(keep)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Copy a snapshot's restore-able files (package.json, cordis.patch.yml) back into a profile dir. */
export function restoreSnapshot(home: string, profile: string, snapDir: string): void {
  const target = profileDir(home, profile)
  for (const f of ['package.json', 'cordis.patch.yml'] as const) {
    const srcFile = join(snapDir, f)
    if (existsSync(srcFile)) {
      copyFileSync(srcFile, join(target, f))
    }
  }
}

/** A non-empty snapshot is one that has at least a package.json. */
export function isUsableSnapshot(snapDir: string): boolean {
  return existsSync(join(snapDir, 'package.json'))
}