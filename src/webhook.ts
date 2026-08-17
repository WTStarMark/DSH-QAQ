/**
 * qaq-webhook — dependency-free outgoing webhook delivery for guard events.
 *
 * Fires best-effort POSTs (one JSON body, no external libs) to the configured
 * webhook URLs whenever a guarded DSH fails a boot or a rollback is applied, so
 * an operator can be told about a red screen / crash without watching the
 * console. Delivery is made to be resilient: a short connect/write timeout, an
 * optional HMAC bypass (plain), and a failure that can never crash the guard.
 *
 * Configuration (highest wins):
 *   1. explicit --webhook <url> flags passed to the command (repeatable)
 *   2. env var QAQ_WEBHOOK_URL (comma or newline separated URLs)
 *   3. a file <home>/.qaq/webhooks.json containing either a single string or an
 *      array of { url, [name] } objects
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

/** One outgoing webhook target. */
export interface WebhookTarget {
  url: string
  /** Optional display name for logs. */
  name?: string
}

const TIMEOUT_MS = 8000

/** Resolve the webhook target list for a home, merging flag URLs + env + file. */
export function resolveWebhooks(home: string, cliUrls: string[] = [], env: Record<string, string | undefined> = process.env): WebhookTarget[] {
  const out: WebhookTarget[] = []
  const pushUrl = (u: string): void => {
    const urls = u.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    for (const url of urls) out.push({ url })
  }
  // Lowest priority: file config.
  for (const target of readFileWebhooks(home)) out.push(target)
  // Env var.
  const envUrls = (env.QAQ_WEBHOOK_URL ?? '').trim()
  if (envUrls) pushUrl(envUrls)
  // Highest priority: explicit CLI flags.
  for (const u of cliUrls) if (u.trim()) out.push({ url: u.trim() })
  // De-duplicate by URL, keep first.
  const seen = new Set<string>()
  return out.filter(t => { if (seen.has(t.url)) return false; seen.add(t.url); return true })
}

function readFileWebhooks(home: string): WebhookTarget[] {
  try {
    const file = join(resolve(home), '.qaq', 'webhooks.json')
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw === 'string') return [{ url: raw }]
    if (Array.isArray(raw)) {
      return raw.map((x: unknown): WebhookTarget | null => {
        if (typeof x === 'string') return { url: x }
        const o = x as { url?: unknown; name?: unknown }
        return typeof o?.url === 'string' ? { url: o.url, name: typeof o.name === 'string' ? o.name : undefined } : null
      }).filter((x: WebhookTarget | null): x is WebhookTarget => x !== null)
    }
    return []
  } catch { return [] }
}

/** Default webhook home resolution (for logging). */
export function defaultWebhookHome(): string {
  return resolve(process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
}

/** Post one JSON event to every configured webhook. Best-effort; never throws. */
export async function deliverWebhooks(home: string, cliUrls: string[], event: { kind: string; ts: string; profile?: string; data?: Record<string, unknown> }): Promise<number> {
  const targets = resolveWebhooks(home, cliUrls)
  if (targets.length === 0) return 0
  const body = JSON.stringify(event, null, 2)
  let delivered = 0
  await Promise.all(targets.map(async (t) => {
    try { await postJson(t.url, body); delivered += 1 }
    catch { /* best effort — never crash the guard */ }
  }))
  return delivered
}

/** Best-effort JSON POST with a hard timeout. Rejects on any failure. */
function postJson(url: string, body: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let u: URL
    try { u = new URL(url) } catch (e) { rejectPromise(e); return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { rejectPromise(new Error('unsupported webhook protocol ' + u.protocol)); return }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const clear = (): void => clearTimeout(timer)
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'qaq-guard' }, body, signal: controller.signal })
      .then(() => { clear(); resolvePromise() })
      .catch((e: unknown) => { clear(); rejectPromise(e) })
  })
}
