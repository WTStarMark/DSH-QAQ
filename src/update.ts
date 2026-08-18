/**
 * Version update checks (Beta) — added in QAQ 0.4.4.
 *
 * The local version is read from the package.json sitting next to the bundle
 * (`src/` and `dist/` are both one level under the repo root, so
 * `../package.json` resolves in dev (tsx) and in the esbuild bundle alike).
 * The remote "latest" version is read from the repo's package.json on the
 * master branch — the repo publishes no releases/tags yet, so the raw file is
 * the authoritative version source. Comparison is a plain numeric
 * major.minor.patch triple.
 *
 * All network I/O goes through an injectable fetch (default: the Node 22
 * global), so the logic is unit-testable offline with a stub response.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qaqDir, resolveDshHome } from './paths.ts'

/** The GitHub repo the update check talks to. */
export const UPDATE_REPO = 'WTStarMark/QAQ'
/** Branch used as the update source (no tags/releases exist yet). */
export const UPDATE_BRANCH = 'master'
/** Raw package.json of the latest master — carries the remote version. */
export const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/package.json'
/** Master source archive (zip) — what a confirmed update downloads. */
export const UPDATE_SOURCE_URL = 'https://codeload.github.com/' + UPDATE_REPO + '/zip/refs/heads/' + UPDATE_BRANCH
/** Network timeout for check/download (ms). */
export const UPDATE_TIMEOUT_MS = 8000

export interface VersionTriple { major: number; minor: number; patch: number }

/** Parse "v?M.m.p..." into a numeric triple; null on garbage. */
export function parseVersion(s: string): VersionTriple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** -1 if a < b, 0 if equal, 1 if a > b; an unparsable version compares as 0.0.0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a) ?? { major: 0, minor: 0, patch: 0 }
  const vb = parseVersion(b) ?? { major: 0, minor: 0, patch: 0 }
  const cmp = (x: number, y: number): -1 | 0 | 1 => (x > y ? 1 : x < y ? -1 : 0)
  return cmp(va.major, vb.major) || cmp(va.minor, vb.minor) || cmp(va.patch, vb.patch)
}

/** Read the local QAQ version from the package.json next to this bundle. */
export function resolveLocalVersion(): string {
  try {
    const pj = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const v = (JSON.parse(readFileSync(pj, 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : '0.0.0'
  } catch { return '0.0.0' }
}

export interface UpdateCheckResult {
  ok: boolean
  /** The local version (read from this checkout). */
  current: string
  /** The remote version (null when the check failed). */
  latest: string | null
  /** True only when latest > current and both parse. */
  updateAvailable: boolean
  error?: string
}

export interface UpdateCheckOptions {
  /** fetch implementation (default: global fetch). */
  fetchImpl?: typeof fetch
  /** Request timeout in ms (default UPDATE_TIMEOUT_MS). */
  timeoutMs?: number
  /** Remote package.json URL to check (default UPDATE_CHECK_URL). */
  url?: string
}

/** Check GitHub for a newer QAQ. Never throws — failures return ok:false. */
export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const current = resolveLocalVersion()
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const timeoutMs = opts.timeoutMs ?? UPDATE_TIMEOUT_MS
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(opts.url ?? UPDATE_CHECK_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return { ok: false, current, latest: null, updateAvailable: false, error: 'HTTP ' + res.status }
    const json = await res.json() as { version?: unknown }
    const latest = typeof json?.version === 'string' ? json.version : ''
    if (!latest || !parseVersion(latest)) {
      return { ok: false, current, latest: null, updateAvailable: false, error: 'no parseable version in remote package.json' }
    }
    return { ok: true, current, latest, updateAvailable: compareVersions(latest, current) > 0 }
  } catch (err) {
    return { ok: false, current, latest: null, updateAvailable: false, error: String(err instanceof Error ? err.message : err) }
  }
}

export interface UpdateDownloadOptions {
  /** Version label used in the saved file name. */
  version: string
  /** Directory to save into (default: <home>/.qaq/update). */
  dir?: string
  /** fetch implementation (default: global fetch). */
  fetchImpl?: typeof fetch
  /** Request timeout in ms (default UPDATE_TIMEOUT_MS). */
  timeoutMs?: number
}

export interface UpdateDownloadResult {
  ok: boolean
  /** Absolute path of the saved archive (ok:true only). */
  path?: string
  error?: string
}

/** Download the latest master source archive as `qaq-<version>.zip`. Never
 *  throws — failures return ok:false. */
export async function downloadUpdateSource(opts: UpdateDownloadOptions): Promise<UpdateDownloadResult> {
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const timeoutMs = opts.timeoutMs ?? UPDATE_TIMEOUT_MS
  const dir = opts.dir ?? join(qaqDir(resolveDshHome()), 'update')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(UPDATE_SOURCE_URL, { signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'qaq-' + (opts.version || 'latest') + '.zip')
    writeFileSync(file, buf)
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
