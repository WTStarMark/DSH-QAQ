/**
 * L3 UI-failure detector: drive a headless Chrome and read the real DOM.
 * Detection is TEXT-based (see plan §0.4): the red-screen structural class
 * names are CSS-Module hashed and unstable, but the fixed text
 * "Failed to load plugins" is pinned in AppRoot.tsx.
 */
import type { CdpSession } from './cdp.ts'
import { launchSession } from './cdp.ts'

/** The exact pinned failure marker rendered by the web boot (AppRoot.tsx). */
export const FAILED_MARKER = 'Failed to load plugins'

export interface DomSnapshot {
  bodyText: string
  /** Whether a real composer textarea is present (hallmark of settled healthy UI). */
  hasComposer: boolean
  /** Whether the boot page (spinner) is still present. */
  isBootPage: boolean
}

export interface UiVerdict {
  ok: boolean
  kind: 'loading' | 'failed' | 'ok' | 'error'
  bodyText: string
  failureDetail?: string
  failedEntries?: string[]
  /** True when the red screen is a DETERMINISTIC config error ("1 entry did
   *  not activate … waiting for service"), so the guard may roll back on the
   *  first hit instead of waiting out the general same-kind threshold. */
  definitive?: boolean
  /** Console ERROR messages sampled during the probe window (bundle load
   *  failures, runtime exceptions) — a degradation signal beyond the DOM. */
  consoleErrors?: string[]
}

/** Attach sampled console errors to a verdict (pure — trivially testable). */
export function withConsoleErrors(v: UiVerdict, errors: string[]): UiVerdict {
  return errors.length > 0 ? { ...v, consoleErrors: errors } : v
}

const DOM_PROBE =`
(() => {
  const bodyText = document.body ? (document.body.innerText || '') : '';
  const root = document.getElementById('root');
  let hasComposer = false;
  let isBootPage = false;
  if (root) {
    hasComposer = !!root.querySelector('textarea');
    // The boot card carries the HARNESS wordmark and has no composer.
    isBootPage = bodyText.includes('HARNESS') && !hasComposer;
  }
  return { bodyText: bodyText.slice(0, 1200), hasComposer, isBootPage };
})()`

export function classifyDom(snap: DomSnapshot): UiVerdict {
  const hasFailed = snap.bodyText.includes(FAILED_MARKER)
  if (hasFailed) {
    const detail = extractFailureDetail(snap.bodyText)
    return {
      ok: false, kind: 'failed', bodyText: snap.bodyText, failureDetail: detail,
      failedEntries: parseFailedEntries(detail), definitive: isDefinitiveUi(detail),
    }
  }
  if (snap.hasComposer) {
    return { ok: true, kind: 'ok', bodyText: snap.bodyText }
  }
  if (snap.isBootPage) {
    return { ok: false, kind: 'loading', bodyText: snap.bodyText }
  }
  // None of the markers present yet (page still loading assets).
  return { ok: false, kind: 'loading', bodyText: snap.bodyText }
}

export function extractFailureDetail(bodyText: string): string | undefined {
  const m = bodyText.match(/web boot:.{0,400}/s)
  return m ? m[0].trim() : undefined
}

export function parseFailedEntries(detail: string | undefined): string[] {
  const names: string[] = []
  if (!detail) return names
  // Format A (single-entry inline): "web boot: 1 entry did not activate dsh-x: pending (waiting for service: y)"
  const inline = /did not activate\s+([\w@/.-]+)/g
  let mm = inline.exec(detail)
  while (mm) { names.push(mm[1]); mm = inline.exec(detail) }
  // Format B (sweeper per-line body): "<id>: pending|failed|import failed ..."
  const linesA = detail.split(/\r?\n/).map(l => l.trim())
  for (const line of linesA) {
    if (/web boot:/i.test(line)) continue
    const m = line.match(/^([\w@/.-]+)\s*:\s*(pending|failed|import failed)/)
    if (m) names.push(m[1])
  }
  return Array.from(new Set(names))
}

/**
 * A DETERMINISTIC UI boot failure — e.g. a bundle entry whose client fiber is
 * waiting forever on a service nobody provides: `web boot: 1 entry did not
 * activate dsh-x: pending (waiting for service: y)`. These never resolve on
 * retry (they reproduce identically every boot), so the guard treats them like
 * a host fail-loud marker: count once, roll back on the first hit — no need to
 * wait out the general same-kind threshold. The text is pinned by the web boot
 * error renderer and is stable across builds.
 */
export function isDefinitiveUi(detail: string | undefined): boolean {
  if (!detail) return false
  // The canonical deterministic scenario: an entry is blocked on a service the
  // loader tree never provides, so its fiber stays pending forever.
  if (/did not activate/i.test(detail) && /waiting for service/i.test(detail)) return true
  // A loader sweeper explicitly reporting a permanently-failed entry.
  if (/import failed/i.test(detail) && /did not activate/i.test(detail)) return true
  return false
}

export async function probeOnce(session: CdpSession): Promise<UiVerdict> {
  const v = await session.evaluate(DOM_PROBE)
  const snap = (v ?? { bodyText: '', hasComposer: false, isBootPage: false }) as DomSnapshot
  return classifyDom(snap)
}

export async function pollUi(session: CdpSession, url: string, timeoutMs: number): Promise<UiVerdict> {
  await session.evaluate(`window.location.href = ${JSON.stringify(url)}`)
  const start = Date.now()
  let last: UiVerdict | null = null
  // Probe at least once: a 0/negative timeout (e.g. --confirm-ms 0) must still
  // yield one real DOM read instead of an immediate 'error'.
  do {
    last = await probeOnce(session)
    if (last.kind === 'failed' || last.kind === 'ok') return last
    await sleep(500)
  } while (Date.now() - start < timeoutMs)
  return last ?? { ok: false, kind: 'error', bodyText: '' }
}

export async function detectUi(url: string, timeoutMs = 25000, port = 0): Promise<UiVerdict> {
  // A random debug port in 9000-9899 can collide with a foreign process; retry
  // with a fresh random port instead of burning 15s and failing the boot.
  const attempts = port > 0 ? 1 : 3
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const debugPort = port > 0 ? port : (9000 + Math.floor(Math.random() * 900))
    try {
      const session = await launchSession({ debugPort })
      try {
        // Sample console ERROR events during the probe window — a degradation
        // signal beyond the DOM (bundle load failures, runtime exceptions).
        await session.command('Runtime.enable').catch(() => {})
        const errors: string[] = []
        session.onConsoleError((text) => { if (errors.length < 10) errors.push(text) })
        const verdict = await pollUi(session, url, timeoutMs)
        return withConsoleErrors(verdict, errors)
      } finally { await session.close() }
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : ''
      // Explicit port or a missing browser: no point retrying.
      if (port > 0 || /no Chrome|no Chromium/i.test(msg)) throw err
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }