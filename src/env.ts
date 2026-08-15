/**
 * Environment auto-discovery and pre-launch self-check (懒人脚本 part):
 *  - find the `dsh` command (PATH) or a DSH checkout (--cwd / QAQ_DSH_CMD /
 *    a parent/sibling checkout scan)
 *  - find a usable browser for the UI probe (Chrome/Chromium/Edge)
 *  - check whether the target port is free
 *  - assemble the supervised command with sane defaults
 *
 * Nothing here is fatal by itself — it reports problems so the CLI can show
 * clear, actionable Chinese guidance before failing.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import net from 'node:net'
import { findBrowser as findBrowserFromCdp } from './cdp.ts'
import { resolveDshHome } from './paths.ts'
import { makeT, resolveLang, type Lang, type T } from './i18n.ts'

export interface EnvReport {
  home: string
  command: string[]
  cwd: string
  commandSource: 'PATH' | 'QAQ_DSH_CMD' | 'checkout' | 'none'
  dshOnPath?: string
  checkout?: string
  browser?: string
  port: number
  problems: EnvProblem[]
}

export interface EnvProblem {
  sev: 'error' | 'warn'
  code: string
  message: string
  hint: string
}

/** Resolve the dsh CLI entry inside a possible DSH checkout root. */
export function findCheckoutCli(root: string): string | null {
  const candidates = [
    join(root, 'apps', 'cli', 'src', 'bin.ts'),
    join(root, 'apps', 'cli', 'src', 'index.ts'),
    join(root, 'apps', 'cli', 'dist', 'index.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function findDshBinary(): string | undefined {
  const p = process.env.PATH ?? ''
  // Windows PATH is ';'-separated; POSIX is ':'. Drive letters (C:\...) make a
  // blanket /[;:]/ split unsafe on Windows, so pick the separator by platform.
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const chunk of p.split(sep)) {
    const dir = chunk.replace(/^"+|"+$/g, '')
    if (!dir) continue
    for (const name of ['dsh', 'dsh.exe', 'dsh.cmd', 'dsh.bat']) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/** Look for a DSH checkout near process.cwd(): its ancestor chain, then a
 * sibling checkout next to the cwd (the common "tool sits beside the checkout"
 * layout, e.g. QAQ and deepseek-harness side by side under one project dir). */
export function findAutoCheckout(): { root: string; cli: string } | null {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const cli = findCheckoutCli(dir)
    if (cli) return { root: dir, cli }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Sibling scan: any direct child of the cwd's parent that looks like a DSH
  // checkout (has apps/cli). Covers double-clicking qaq-web.cmd from the tool's
  // own directory while the checkout lives next to it.
  const parent = dirname(process.cwd())
  if (parent !== process.cwd()) {
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(parent, entry.name)
        const cli = findCheckoutCli(candidate)
        if (cli) return { root: candidate, cli }
      }
    } catch { /* unreadable parent: give up on the sibling scan */ }
  }
  return null
}

/** Resolve the dsh command. Order: QAQ_DSH_CMD → --cwd checkout → scan → PATH. */
export function resolveCommand(cwdArg?: string): { command: string[]; cwd: string; source: EnvReport['commandSource']; checkout?: string; dshOnPath?: string } {
  const explicit = process.env.QAQ_DSH_CMD
  if (explicit) {
    return { command: explicit.split(' ').filter(Boolean), cwd: cwdArg ?? process.cwd(), source: 'QAQ_DSH_CMD' }
  }
  if (cwdArg) {
    const abs = resolve(cwdArg)
    const cli = findCheckoutCli(abs)
    if (cli) return { command: ['node', '--import', 'tsx/esm', cli, 'web'], cwd: abs, source: 'checkout', checkout: abs }
    return { command: ['dsh', 'web'], cwd: abs, source: 'PATH' }
  }
  const auto = findAutoCheckout()
  if (auto) {
    return { command: ['node', '--import', 'tsx/esm', auto.cli, 'web'], cwd: auto.root, source: 'checkout', checkout: auto.root }
  }
  const onPath = findDshBinary()
  return { command: onPath ? [onPath, 'web'] : ['dsh', 'web'], cwd: process.cwd(), source: onPath ? 'PATH' : 'none', dshOnPath: onPath }
}

/** Probe whether a TCP port is free on 127.0.0.1. Resolves true if free. */
export function isPortFree(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((res) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (v: boolean): void => { socket.destroy(); res(v) }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.setTimeout(timeoutMs, () => done(true))
  })
}

/** Resolve the DSH home (honors $DSH_HOME then ~/.dsh). Single implementation
 * lives in paths.ts; re-exported here for callers that import from env.ts. */
export { resolveDshHome } from './paths.ts'

/**
 * Full pre-launch self-check. Returns an EnvReport plus problems.
 * The caller decides whether `error` problems are fatal (they are for the
 * supervised-launch path).
 */
export async function preflight(inOpts?: { cwd?: string; port?: number; lang?: Lang }): Promise<EnvReport> {
  const port = inOpts?.port ?? 3080
  const lang = inOpts?.lang ?? resolveLang([])
  const t: T = makeT(lang)
  const { command, cwd, source, checkout, dshOnPath } = resolveCommand(inOpts?.cwd)
  const p: EnvProblem[] = []

  if (source === 'none') {
    p.push({
      sev: 'error', code: 'DSH_NOT_FOUND',
      message: t('env.DSH_NOT_FOUND.msg'), hint: t('env.DSH_NOT_FOUND.hint'),
    })
  }

  const browser = findBrowserFromCdp() ?? undefined
  if (!browser) {
    p.push({
      sev: 'error', code: 'NO_BROWSER',
      message: t('env.NO_BROWSER.msg'), hint: t('env.NO_BROWSER.hint'),
    })
  }

  const free = await isPortFree(port)
  if (!free) {
    p.push({
      sev: 'error', code: 'PORT_BUSY',
      message: t('env.PORT_BUSY.msg', { port }), hint: t('env.PORT_BUSY.hint'),
    })
  }

  if (checkout && !findCheckoutCli(checkout)) {
    p.push({ sev: 'warn', code: 'CHECKOUT_INCOMPLETE', message: t('env.CHECKOUT_INCOMPLETE.msg'), hint: t('env.CHECKOUT_INCOMPLETE.hint') })
  }

  return {
    home: resolveDshHome(), command, cwd, commandSource: source, dshOnPath, checkout, browser,
    port, problems: p,
  }
}

/** Human-readable single-line summary of the preflight problems (for the banner). */
export function problemBanner(report: EnvReport, lang: Lang = resolveLang([])): string {
  const t: T = makeT(lang)
  const errs = report.problems.filter(x => x.sev === 'error')
  const warns = report.problems.filter(x => x.sev === 'warn')
  const out: string[] = []
  for (const e of errs) out.push(t('env.banner.error') + e.message + '   → ' + e.hint)
  for (const w of warns) out.push(t('env.banner.warn') + w.message + '   → ' + w.hint)
  return out.join('\n')
}

/** Render the "what will be launched" summary for the pre-launch banner. */
export function launchSummary(report: EnvReport, lang: Lang = resolveLang([])): string {
  const t: T = makeT(lang)
  const parts: string[] = []
  parts.push(t('env.launch.command') + report.command.join(' '))
  parts.push(t('env.launch.cwd') + report.cwd)
  parts.push(t('env.launch.home') + report.home)
  if (report.browser) parts.push(t('env.launch.browser') + report.browser)
  parts.push(t('env.launch.port') + report.port)
  return parts.join('\n')
}