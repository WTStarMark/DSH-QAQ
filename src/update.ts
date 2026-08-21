/**
 * Version update checks (Beta) — added in QAQ 0.4.4.
 *
 * The local version is read from the package.json sitting next to the bundle
 * (`src/` and `dist/` are both one level under the repo root, so
 * `../package.json` resolves in dev (tsx) and in the esbuild bundle alike).
 * The remote "latest" version is read THROUGH THE GITHUB API (contents
 * endpoint — base64-encoded package.json of the repo's default branch). The
 * raw.githubusercontent.com variant was dropped: it is unreachable on some
 * networks (and the renamed repo's default branch is `main`, not `master`),
 * so `?ref=` pins it explicitly. Comparison is a plain numeric
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
export const UPDATE_REPO = 'WTStarMark/DSH-QAQ'
/** Branch used as the update source (the renamed repo's default branch is
 *  `main`; there is no `master`). */
export const UPDATE_BRANCH = 'main'
/** API contents copy of the branch's package.json — carries the remote version
 *  as a base64 payload (raw.githubusercontent.com is unreliable/blocked on some
 *  networks, so the check goes through api.github.com). */
export const UPDATE_CHECK_URL = 'https://api.github.com/repos/' + UPDATE_REPO + '/contents/package.json?ref=' + UPDATE_BRANCH
/** Default-branch source archive (zip) — what a confirmed update downloads. */
export const UPDATE_SOURCE_URL = 'https://codeload.github.com/' + UPDATE_REPO + '/zip/refs/heads/' + UPDATE_BRANCH
/** Network timeout for check/download (ms). */
export const UPDATE_TIMEOUT_MS = 15000

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

/** ---------------------------------------------------------------------------
 * Full semver comparison (incl. prerelease) — used for DSH versions, whose
 * releases are `0.1.0-rc.N` chains. Mirrors the rules of DSH's own release
 * tooling (scripts/release/bump.ts compareVersions):
 *   - release numbers dominate (0.1.1 > 0.1.0 regardless of prerelease)
 *   - a prerelease ranks BELOW the release it precedes (0.1.1-rc.1 < 0.1.1)
 *   - rc fields compare numerically (`rc.10 > rc.2`)
 *   - numeric prerelease fields rank BELOW alphanumeric ones
 * Unparsable input compares as 0.0.0 (same convention as compareVersions).
 * ------------------------------------------------------------------------- */

export interface SemverParts {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers split on '.', empty when absent. */
  pre: string[]
}

/** Parse "v?M.m.p[-pre...]" into parts; null on garbage. */
export function parseSemver(s: string): SemverParts | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(s).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** -1 if a < b, 0 if equal, 1 if a > b (full semver precedence incl. rc). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a) ?? { major: 0, minor: 0, patch: 0, pre: [] }
  const pb = parseSemver(b) ?? { major: 0, minor: 0, patch: 0, pre: [] }
  const cmp = (x: number, y: number): -1 | 0 | 1 => (x > y ? 1 : x < y ? -1 : 0)
  const numbers = cmp(pa.major, pb.major) || cmp(pa.minor, pb.minor) || cmp(pa.patch, pb.patch)
  if (numbers !== 0) return numbers
  const aPre = pa.pre, bPre = pb.pre
  if (aPre.length === 0 || bPre.length === 0) {
    if (aPre.length === bPre.length) return 0
    // A release outranks its own prereleases.
    return aPre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    const x = aPre[i], y = bPre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xN = /^\d+$/.test(x), yN = /^\d+$/.test(y)
    if (xN && yN) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0 ? 1 : -1
      continue
    }
    if (xN !== yN) return xN ? -1 : 1 // numeric < alphanumeric
    return x < y ? -1 : 1
  }
  return 0
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

/** Pull a version string out of either a plain package.json payload
 *  ({\"version\": \"0.4.5\"}) or a GitHub API contents payload
 *  ({encoding: \"base64\", content: \"…\"}). Null when absent/unparsable. */
export function extractRemoteVersion(json: Record<string, unknown> | null | undefined): string | null {
  if (!json || typeof json !== 'object') return null
  if (typeof json.version === 'string') return json.version
  if (json.encoding === 'base64' && typeof json.content === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')) as { version?: unknown }
      return typeof decoded.version === 'string' ? decoded.version : null
    } catch { return null }
  }
  return null
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
    const latest = await extractRemoteVersion(await res.json() as Record<string, unknown>)
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
