import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCheckoutVersion, resolveDshVersion, extractVersionFromOutput, resolveDshVersionSync,
} from '../src/dsh-version.ts'

function stageCheckout(version: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'qaq-dshver-'))
  mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
  if (version !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version }), 'utf8')
  return dir
}

describe('readCheckoutVersion', () => {
  it('reads the workspace root manifest version', () => {
    const dir = stageCheckout('0.1.0-rc.5')
    try { expect(readCheckoutVersion(dir)).toBe('0.1.0-rc.5') }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns null for a missing manifest', () => {
    const dir = stageCheckout(null)
    try { expect(readCheckoutVersion(dir)).toBeNull() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('extractVersionFromOutput', () => {
  it('pulls the x.y.z[-pre] token from dsh --version output', () => {
    expect(extractVersionFromOutput('0.1.1-rc.1\n')).toBe('0.1.1-rc.1')
    expect(extractVersionFromOutput('dsh 0.1.0-rc.8\r\n')).toBe('0.1.0-rc.8')
    expect(extractVersionFromOutput('no version here')).toBeNull()
  })
})

describe('resolveDshVersion', () => {
  it('prefers the checkout manifest (no exec needed)', async () => {
    const dir = stageCheckout('0.1.0-rc.5')
    try {
      const r = await resolveDshVersion({ checkout: dir })
      expect(r).toEqual({ version: '0.1.0-rc.5', source: 'checkout' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('falls back to running dsh --version when allowExec', async () => {
    const execImpl = async (): Promise<{ ok: boolean; stdout: string }> => ({ ok: true, stdout: '0.1.1-rc.1\n' })
    const r = await resolveDshVersion({ allowExec: true, command: ['dsh', '--version'], cwd: '/tmp', execImpl })
    expect(r).toEqual({ version: '0.1.1-rc.1', source: 'command' })
  })

  it('never execs without allowExec', async () => {
    let called = false
    const execImpl = async (): Promise<{ ok: boolean; stdout: string }> => { called = true; return { ok: true, stdout: '9.9.9\n' } }
    const r = await resolveDshVersion({ command: ['dsh', '--version'], execImpl })
    expect(r).toEqual({ version: null, source: 'none' })
    expect(called).toBe(false)
  })

  it('returns none on an exec failure', async () => {
    const execImpl = async (): Promise<{ ok: boolean; stdout: string }> => ({ ok: false, stdout: '' })
    const r = await resolveDshVersion({ allowExec: true, command: ['dsh'], execImpl })
    expect(r).toEqual({ version: null, source: 'none' })
  })
})

describe('resolveDshVersionSync', () => {
  it('reads only from the checkout', () => {
    const dir = stageCheckout('0.1.0-rc.7')
    try { expect(resolveDshVersionSync(dir)).toBe('0.1.0-rc.7'); expect(resolveDshVersionSync(null)).toBeNull() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
