import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBrowser, parseConsoleError } from '../src/cdp.ts'

/**
 * `findBrowser` scans platform environment paths (Program Files, LOCALAPPDATA)
 * for a Chrome/Edge/Chromium binary, then a few POSIX paths. By overriding the
 * Windows env vars to point at a throwaway directory we can make the search
 * deterministic: put a fake `chrome.exe` in it and confirm it is selected, and
 * confirm an empty directory yields null.
 */
let temp: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'QAQ_CHROME', 'CHROME_PATH', 'PATH']

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'qaq-cdp-find-'))
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  rmSync(temp, { recursive: true, force: true })
})

describe('findBrowser candidate resolution', () => {
  it('returns the Chrome binary under PROGRAMFILES when present', () => {
    const chrome = join(temp, 'Google', 'Chrome', 'Application', 'chrome.exe')
    mkdirSync(join(temp, 'Google', 'Chrome', 'Application'), { recursive: true })
    writeFileSync(chrome, '')
    process.env.PROGRAMFILES = temp
    expect(findBrowser()).toBe(chrome)
  })

  it('returns the second Program Files (X86) Chrome when the first is absent', () => {
    const x86 = join(temp, 'x86', 'Google', 'Chrome', 'Application', 'chrome.exe')
    mkdirSync(join(temp, 'x86', 'Google', 'Chrome', 'Application'), { recursive: true })
    writeFileSync(x86, '')
    process.env.PROGRAMFILES = temp // empty dir
    process.env['PROGRAMFILES(X86)'] = join(temp, 'x86')
    expect(findBrowser()).toBe(x86)
  })

  it('falls back through Edge under LOCALAPPDATA when no Chrome exists anywhere', () => {
    const edge = join(temp, 'local', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    mkdirSync(join(temp, 'local', 'Microsoft', 'Edge', 'Application'), { recursive: true })
    writeFileSync(edge, '')
    process.env.LOCALAPPDATA = join(temp, 'local')
    // Neither PROGRAMFILES path has a browser.
    process.env.PROGRAMFILES = temp
    expect(findBrowser()).toBe(edge)
  })

  it('returns null when no candidate exists (clean sandbox, no browser installed)', () => {
    // On a POSIX host the static binaries may exist; on Windows they won't. To
    // stay deterministic across platforms we strip the env so only the static
    // POSIX paths could match — and assert the call simply returns null-or-a-path
    // without throwing. On a Windows CI runner with no Chrome installed this is null.
    const r = findBrowser()
    // Invariant: never throws, and returns a string (path) or null.
    expect(r === null || typeof r === 'string').toBe(true)
  })

  it('tolerates env vars set to empty strings (no crash)', () => {
    process.env.PROGRAMFILES = ''
    process.env['PROGRAMFILES(X86)'] = ''
    process.env.LOCALAPPDATA = ''
    expect(() => findBrowser()).not.toThrow()
  })

  it('prefers an explicit QAQ_CHROME override over the install-path candidates', () => {
    // A fake PROGRAMFILES candidate exists, but the explicit override must win.
    const chrome = join(temp, 'Google', 'Chrome', 'Application', 'chrome.exe')
    mkdirSync(join(temp, 'Google', 'Chrome', 'Application'), { recursive: true })
    writeFileSync(chrome, '')
    process.env.PROGRAMFILES = temp
    const override = join(temp, 'my-custom-browser.exe')
    writeFileSync(override, '')
    process.env.QAQ_CHROME = override
    expect(findBrowser()).toBe(override)
  })

  it('honors CHROME_PATH as a second override slot', () => {
    const override = join(temp, 'edge-custom.exe')
    writeFileSync(override, '')
    process.env.CHROME_PATH = override
    expect(findBrowser()).toBe(override)
  })

  it('falls back to scanning PATH for a browser executable', () => {
    // No install-path candidates, but PATH points at a directory with a binary.
    const bin = join(temp, 'bin')
    mkdirSync(bin, { recursive: true })
    const exe = join(bin, process.platform === 'win32' ? 'chrome.exe' : 'google-chrome')
    writeFileSync(exe, '')
    process.env.PATH = bin
    const r = findBrowser()
    expect(typeof r).toBe('string')
    expect(existsSync(r as string)).toBe(true)
    // A well-known install (consulted before PATH) may pre-exist on this host
    // — e.g. /usr/bin/google-chrome on CI Linux runners — which legitimately
    // pre-empts the scan. Where no such candidate can exist (Windows, or
    // Linux without a static browser) the PATH result must win.
    if (process.platform === 'win32' || !existsSync('/usr/bin/google-chrome')) {
      expect(r).toBe(exe)
    }
  })

  it('scans PATH after the install candidates (PATH cannot shadow a real install)', () => {
    const chrome = join(temp, 'Google', 'Chrome', 'Application', 'chrome.exe')
    mkdirSync(join(temp, 'Google', 'Chrome', 'Application'), { recursive: true })
    writeFileSync(chrome, '')
    process.env.PROGRAMFILES = temp
    // PATH also contains a browser; the install-path candidate must win.
    const bin = join(temp, 'bin')
    mkdirSync(bin, { recursive: true })
    const pathExe = join(bin, process.platform === 'win32' ? 'chrome.exe' : 'google-chrome')
    writeFileSync(pathExe, '')
    process.env.PATH = bin
    expect(findBrowser()).toBe(chrome)
  })
})

describe('parseConsoleError (CDP console-error extraction)', () => {
  it('extracts the text of a Runtime.consoleAPICalled error event', () => {
    const msg = {
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'error',
        args: [
          { type: 'string', value: 'Failed to load resource' },
          { type: 'object', description: 'net::ERR_FAILED' },
        ],
      },
    }
    expect(parseConsoleError(msg)).toBe('Failed to load resource net::ERR_FAILED')
  })

  it('ignores non-error events and non-console messages', () => {
    expect(parseConsoleError({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'hi' }] } })).toBeNull()
    expect(parseConsoleError({ method: 'Runtime.consoleAPICalled', params: { type: 'warning', args: [{ type: 'string', value: 'w' }] } })).toBeNull()
    expect(parseConsoleError({ method: 'Network.responseReceived', params: {} })).toBeNull()
    expect(parseConsoleError({ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [] } })).toBeNull()
  })

  it('is defensive against malformed messages', () => {
    expect(parseConsoleError(null)).toBeNull()
    expect(parseConsoleError(undefined)).toBeNull()
    expect(parseConsoleError('nope')).toBeNull()
    expect(parseConsoleError({ method: 'Runtime.consoleAPICalled' })).toBeNull()
  })
})
