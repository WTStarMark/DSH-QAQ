/**
 * Minimal CDP client (WebSocket) used to open a page, evaluate JS, and read the
 * real DOM — the L3 UI-failure detector. No Playwright/Puppeteer dependency.
 */
import WebSocket from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Locate a Chrome/Edge binary on this host (Windows + POSIX candidates). */
export function findBrowser(): string | null {
  const candidates = [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] as (string | undefined)[]
  for (const c of candidates) { if (c && existsSync(c)) return c }
  return null
}

/** A live CDP page session. */
export interface CdpSession {
  /** Evaluate an expression and return its JSON value (or null on error/failure). */
  evaluate(expr: string): Promise<unknown>
  close(): Promise<void>
}

export interface LaunchOptions { debugPort: number }

/**
 * Launch a dedicated headless Chrome and return a CDP page session. The caller
 * owns and must close the returned session (kills the browser, cleans the
 * temp user-data dir).
 */
export async function launchSession(opts: LaunchOptions): Promise<CdpSession> {
  const browser = findBrowser()
  if (!browser) throw new Error('no Chrome/Chromium found to drive the UI detector')
  const udd = mkdtempSync(join(tmpdir(), 'qaq-cdp-'))
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + opts.debugPort,
    '--remote-allow-origins=*', '--user-data-dir=' + udd,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let targets: any = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + opts.debugPort + '/json')
      if (res.ok) { targets = await res.json() as any; break }
    } catch { /* not up yet */ }
    await sleep(300)
  }
  if (!targets) { killChild(child); rmSync(udd, { recursive: true, force: true }); throw new Error('headless browser did not expose CDP on port ' + opts.debugPort) }
  const page = Array.isArray(targets) ? targets.find((t: any) => t.type === 'page') : null
  if (!page?.webSocketDebuggerUrl) { killChild(child); rmSync(udd, { recursive: true, force: true }); throw new Error('no page target on CDP endpoint') }

  const ws = await connectWs(page.webSocketDebuggerUrl as string)
  return new CdpsSessionImpl(child, udd, ws)
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
function killChild(c: ChildProcess): void { try { c.kill('SIGKILL') } catch { /* ignore */ } }

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

class CdpsSessionImpl implements CdpSession {
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false
  constructor(private child: ChildProcess, private udd: string, private ws: WebSocket) {
    ws.on('message', (data) => {
      let msg: any
      try { msg = JSON.parse(String(data)) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error('CDP error: ' + JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    })
    ws.on('close', () => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error('CDP closed'))
      this.pending.clear()
    })
  }
  private cmd(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  async evaluate(expr: string): Promise<unknown> {
    try {
      const res = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true })
      if (res?.exceptionDetails) return null
      return res?.result?.value ?? null
    } catch { return null }
  }
  async close(): Promise<void> {
    try { await this.cmd('Browser.close') } catch { /* ignore */ }
    if (!this.closed) { try { this.ws.close() } catch { /* ignore */ } }
    killChild(this.child)
    try { rmSync(this.udd, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}