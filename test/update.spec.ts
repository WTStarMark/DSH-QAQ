import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVersion, compareVersions, parseSemver, compareSemver, resolveLocalVersion, checkForUpdate, downloadUpdateSource,
  UPDATE_CHECK_URL, UPDATE_SOURCE_URL,
} from '../src/update.ts'

describe('parseVersion / compareVersions', () => {
  it('parses plain and v-prefixed triples', () => {
    expect(parseVersion('0.4.4')).toEqual({ major: 0, minor: 4, patch: 4 })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('0.4.4-beta')).toEqual({ major: 0, minor: 4, patch: 4 })
  })

  it('rejects garbage', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })

  it('orders the QAQ release chain (0.x.3 → 0.4.5)', () => {
    expect(compareVersions('0.0.3', '0.1.3')).toBe(-1)
    expect(compareVersions('0.1.3', '0.2.3')).toBe(-1)
    expect(compareVersions('0.2.3', '0.3.3')).toBe(-1)
    expect(compareVersions('0.3.3', '0.4.3')).toBe(-1)
    expect(compareVersions('0.4.3', '0.4.4')).toBe(-1)
    expect(compareVersions('0.4.4', '0.4.5')).toBe(-1)
    expect(compareVersions('0.4.5', '0.4.5')).toBe(0)
    expect(compareVersions('0.5.0', '0.4.5')).toBe(1)
  })

  it('treats unparsable versions as 0.0.0', () => {
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
    expect(compareVersions('', '0.0.0')).toBe(0)
  })
})

describe('parseSemver / compareSemver (DSH rc-aware full semver)', () => {
  it('parses prerelease parts', () => {
    expect(parseSemver('0.1.0-rc.5')).toEqual({ major: 0, minor: 1, patch: 0, pre: ['rc', '5'] })
    expect(parseSemver('0.1.1')).toEqual({ major: 0, minor: 1, patch: 1, pre: [] })
    expect(parseSemver('v1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', '1'] })
    expect(parseSemver('garbage')).toBeNull()
  })

  it('orders the DSH rc chain numerically within a release', () => {
    expect(compareSemver('0.1.0-rc.5', '0.1.0-rc.8')).toBe(-1)
    expect(compareSemver('0.1.0-rc.8', '0.1.0-rc.10')).toBe(-1)
    expect(compareSemver('0.1.0-rc.10', '0.1.0-rc.9')).toBe(1)
    expect(compareSemver('0.1.0-rc.5', '0.1.0-rc.5')).toBe(0)
  })

  it('ranks a prerelease below the release it precedes, and release numbers dominate', () => {
    expect(compareSemver('0.1.1-rc.1', '0.1.1')).toBe(-1)
    expect(compareSemver('0.1.1-rc.1', '0.1.1-rc.1')).toBe(0)
    expect(compareSemver('0.1.1', '0.1.1-rc.1')).toBe(1)
    // release numbers dominate regardless of prerelease
    expect(compareSemver('0.1.1-rc.1', '0.1.0-rc.99')).toBe(1)
    expect(compareSemver('0.1.0-rc.8', '0.1.1-rc.1')).toBe(-1)
  })

  it('treats unparsable versions as 0.0.0', () => {
    expect(compareSemver('', '0.0.1')).toBe(-1)
    expect(compareSemver('abc', '0.0.0')).toBe(0)
  })
})

describe('resolveLocalVersion', () => {
  it('reads the repo package.json next to the bundle (0.4.5 after alignment)', () => {
    const v = resolveLocalVersion()
    expect(parseVersion(v)).not.toBeNull()
    expect(compareVersions(v, '0.4.5')).toBe(0)
  })
})

describe('checkForUpdate (Beta)', () => {
  const okFetch = (version: string): typeof fetch => (async () => new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('reports an update when the remote is newer', async () => {
    const r = await checkForUpdate({ fetchImpl: okFetch('0.5.0') })
    expect(r.ok).toBe(true)
    expect(r.updateAvailable).toBe(true)
    expect(r.latest).toBe('0.5.0')
    expect(compareVersions(r.latest!, r.current)).toBe(1)
  })

  it('reports up-to-date when the remote is equal or older', async () => {
    expect((await checkForUpdate({ fetchImpl: okFetch('0.4.5') })).updateAvailable).toBe(false)
    expect((await checkForUpdate({ fetchImpl: okFetch('0.4.4') })).updateAvailable).toBe(false)
  })

  it('decodes a GitHub API base64 contents payload', async () => {
    const payload = { encoding: 'base64', content: Buffer.from(JSON.stringify({ version: '0.5.0' }), 'utf8').toString('base64') }
    const apiFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
    const r = await checkForUpdate({ fetchImpl: apiFetch })
    expect(r.ok).toBe(true)
    expect(r.latest).toBe('0.5.0')
    expect(r.updateAvailable).toBe(true)
  })

  it('fails cleanly on an HTTP error', async () => {
    const r = await checkForUpdate({ fetchImpl: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.updateAvailable).toBe(false)
    expect(r.error).toContain('404')
  })

  it('fails cleanly when the remote payload has no parseable version', async () => {
    const r = await checkForUpdate({ fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch })
    expect(r.ok).toBe(false)
  })

  it('fails cleanly on a network error', async () => {
    const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const r = await checkForUpdate({ fetchImpl: boom })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ECONNREFUSED')
  })

  it('checks the renamed repo’s default branch via the GitHub API', () => {
    expect(UPDATE_CHECK_URL).toContain('api.github.com/repos/WTStarMark/DSH-QAQ/contents/package.json')
    expect(UPDATE_CHECK_URL).toContain('?ref=main')
    expect(UPDATE_SOURCE_URL).toContain('codeload.github.com/WTStarMark/DSH-QAQ/zip/refs/heads/main')
  })
})

describe('downloadUpdateSource (Beta)', () => {
  it('writes the archive into the target dir as qaq-<version>.zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qaq-update-'))
    try {
      const bytes = Buffer.from('PK-fake-zip-bytes')
      const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch
      const r = await downloadUpdateSource({ version: '0.5.0', dir, fetchImpl })
      expect(r.ok).toBe(true)
      expect(r.path).toContain('qaq-0.5.0.zip')
      expect(existsSync(r.path!)).toBe(true)
      expect(readFileSync(r.path!, 'utf8')).toBe('PK-fake-zip-bytes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails cleanly on an HTTP error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qaq-update-'))
    try {
      const fetchImpl = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch
      const r = await downloadUpdateSource({ version: '0.5.0', dir, fetchImpl })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('503')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
