/**
 * Guard orchestration regression tests. These pin the behaviors that were
 * previously only observable on real hosts:
 *  - a boot that never settles (UI timeout) must KILL the supervised child,
 *    not leak it (the leaked child held the port on retry and kept the guard's
 *    event loop alive, hanging the process);
 *  - a boot that degrades during the confirmation window must NOT be recorded
 *    as a successful last-good snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readState } from '../src/store.ts'

const { killMock, spawnDshMock, detectUiMock } = vi.hoisted(() => ({
  killMock: vi.fn(),
  spawnDshMock: vi.fn(),
  detectUiMock: vi.fn(),
}))

vi.mock('../src/spawn-dsh.ts', () => ({
  spawnDsh: (...args: unknown[]) => spawnDshMock(...args),
}))
vi.mock('../src/detector-ui.ts', () => ({
  detectUi: (...args: unknown[]) => detectUiMock(...args),
}))

import { superviseBoot } from '../src/guard.ts'

let home = ''
function mkSupervisor() {
  return {
    child: { exitCode: null as number | null },
    ready: Promise.resolve(true),
    exit: Promise.resolve(null),
    output: () => '',
    hasHostFailureMarker: () => false,
    kill: killMock,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-guard-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"name":"web"}')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]')
  killMock.mockClear()
  spawnDshMock.mockClear()
  detectUiMock.mockClear()
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('guard.bootAttempt leak regression', () => {
  it('kills the supervised child when the UI never settles (no leak, no hang)', async () => {
    spawnDshMock.mockReturnValue(mkSupervisor())
    detectUiMock.mockResolvedValue({ ok: false, kind: 'loading', bodyText: 'HARNESS Loading…' })

    const v = await superviseBoot({ home, command: ['fake'], cwd: '.', profile: 'web', retries: 0, uiTimeoutMs: 50, confirmGoodMs: 0 })

    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.failureKind).toBe('unknown')
      // With retries=0 the single attempt is by definition the exhausted one.
      expect(v.retriesExhausted).toBe(true)
      // The child must be killed — leaking it held the port on retry and hung the guard.
      expect(killMock).toHaveBeenCalled()
    }
  })

  it('classifies a host that crashes after binding the port as host, not unknown', async () => {
    // The child bound the port (ready resolved) but then died with a fail-loud
    // marker before the UI settled — the real "crashed after bind" shape.
    const sup = mkSupervisor()
    sup.child = { exitCode: 1 }
    sup.hasHostFailureMarker = () => true
    spawnDshMock.mockReturnValue(sup)
    detectUiMock.mockResolvedValue({ ok: false, kind: 'loading', bodyText: 'HARNESS Loading…' })

    const v = await superviseBoot({ home, command: ['fake'], cwd: '.', profile: 'web', retries: 0, uiTimeoutMs: 50, confirmGoodMs: 0 })

    expect(v.ok).toBe(false)
    if (!v.ok) {
      // A crashed host must be counted (hostFailures + rollback eligibility),
      // never dropped as an uncounted 'unknown' UI timeout.
      expect(v.failureKind).toBe('host')
    }
  })

  it('does not mark retriesExhausted when a genuine (non-transient) failure stops the loop early', async () => {
    spawnDshMock.mockReturnValue(mkSupervisor())
    detectUiMock.mockResolvedValue({ ok: false, kind: 'failed', bodyText: 'Failed to load plugins', failureDetail: 'web boot: 1 entry did not activate dsh-x: pending (waiting for service: y)' })

    const v = await superviseBoot({ home, command: ['fake'], cwd: '.', profile: 'web', retries: 1, uiTimeoutMs: 100, confirmGoodMs: 0 })

    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.failureKind).toBe('ui')
      // A red screen is not transient: no tolerance retry ran, so retries are NOT exhausted.
      expect(v.retriesExhausted).toBe(false)
      expect(killMock).toHaveBeenCalledTimes(1)
    }
  })

  it('does not record success when the UI degrades during the confirmation window', async () => {
    spawnDshMock.mockReturnValue(mkSupervisor())
    detectUiMock
      .mockResolvedValueOnce({ ok: true, kind: 'ok', bodyText: 'chat' })
      .mockResolvedValueOnce({ ok: false, kind: 'failed', bodyText: 'Failed to load plugins', failureDetail: 'web boot: 1 entry did not activate dsh-x: pending (waiting for service: y)' })

    const v = await superviseBoot({ home, command: ['fake'], cwd: '.', profile: 'web', retries: 0, confirmGoodMs: 10, uiTimeoutMs: 100 })

    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.failureKind).toBe('ui')
    // A degraded confirmation must never be snapshotted as last-good.
    const state = readState(home)
    expect(state.profiles['web'].lastSuccess).toBeUndefined()
    expect(state.profiles['web'].lastGoodSnapshot).toBeUndefined()
  })

  it('records success only after the confirmation re-probe stays healthy', async () => {
    spawnDshMock.mockReturnValue(mkSupervisor())
    detectUiMock.mockResolvedValue({ ok: true, kind: 'ok', bodyText: 'chat area' })

    const v = await superviseBoot({ home, command: ['fake'], cwd: '.', profile: 'web', retries: 0, confirmGoodMs: 10, uiTimeoutMs: 100 })

    expect(v.ok).toBe(true)
    if (v.ok) expect(v.supervisor).toBeDefined()
    const state = readState(home)
    expect(state.profiles['web'].lastSuccess).toBeDefined()
    const manifest = JSON.parse(readFileSync(join(home, '.qaq', 'latest-good', 'manifest.json'), 'utf8'))
    expect(manifest.profile).toBe('web')
  })
})
