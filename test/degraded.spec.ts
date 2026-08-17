import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFailedFibers } from '../src/degraded.ts'
import { writeSharedJson } from '../src/shared-io.ts'

let home = ''
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'qaq-degraded-')) })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })
beforeEach(() => {
  rmSync(join(home, '.qaq'), { recursive: true, force: true })
  rmSync(join(home, 'profiles'), { recursive: true, force: true })
})

describe('detectFailedFibers (non-red-screen degradation signal)', () => {
  it('flags only ENABLED plugins whose fiber ended in the failed state', () => {
    writeSharedJson(home, 'plugin-inventory.json', {
      ts: new Date().toISOString(), profile: 'web', settled: true, count: 4,
      entries: [
        { entryId: 'theme', moduleName: '@deepseek-ai/dsh-client-ui-theme', enabled: true, fiberPhase: 'failed' },
        { entryId: 'conn', moduleName: '@deepseek-ai/dsh-client-connection', enabled: true, fiberPhase: 'active' },
        // Disabled plugins are NOT degraded (their failed fiber is expected).
        { entryId: 'broken', moduleName: 'dsh-broken', enabled: false, fiberPhase: 'failed' },
        // Enabled but no phase reported — not a failed fiber.
        { entryId: 'plain', moduleName: 'dsh-plain', enabled: true },
      ],
    })
    const degraded = detectFailedFibers(home)
    expect(degraded.map((d) => d.name)).toEqual(['@deepseek-ai/dsh-client-ui-theme'])
    expect(degraded[0].entryId).toBe('theme')
  })

  it('returns [] when no inventory is reporting (DSH down)', () => {
    expect(detectFailedFibers(home)).toEqual([])
  })

  it('falls back to the entry id for unnamed modules', () => {
    writeSharedJson(home, 'plugin-inventory.json', {
      ts: new Date().toISOString(), profile: 'web', settled: true, count: 1,
      entries: [{ entryId: 'unnamed-thing', enabled: true, fiberPhase: 'failed' }],
    })
    expect(detectFailedFibers(home).map((d) => d.name)).toEqual(['unnamed-thing'])
  })
})
