import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalConfig, configFingerprint, fnv1aHex, liveBootMatches } from '../src/verify-config.ts'
import { recordSuccess, manualBackup } from '../src/rollback.ts'
import { readState, writeState, profileState, listBackups } from '../src/store.ts'
import { qaqDir, profileDir } from '../src/paths.ts'
import { Logger } from '../src/log.ts'
import { PLUGIN_STATE_FILE, writeSharedJson } from '../src/shared-io.ts'

let home = ''
let log: Logger
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'qaq-verify-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  log = new Logger(home)
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

function writeProfile(profile: string, bundles: string[], patch = '[]'): void {
  const pr = profileDir(home, profile)
  mkdirSync(pr, { recursive: true })
  writeFileSync(join(pr, 'package.json'), JSON.stringify({ name: profile, dsh: { profile: { bundles } } }))
  writeFileSync(join(pr, 'cordis.patch.yml'), patch)
}
function writePluginState(fingerprint: string | null, settled = true): void {
  writeSharedJson(home, PLUGIN_STATE_FILE, { ts: new Date().toISOString(), profile: 'web', settled, ...(fingerprint === null ? {} : { loadedFingerprint: fingerprint }) })
}

describe('config fingerprint (guard plan A)', () => {
  it('fnv1aHex is deterministic and stable', () => {
    expect(fnv1aHex('hello')).toBe(fnv1aHex('hello'))
    expect(fnv1aHex('a')).not.toBe(fnv1aHex('b'))
  })

  it('fingerprint changes when the bundle list changes', () => {
    writeProfile('fp1', ['@deepseek-ai/dsh-base', 'dsh-qaq'])
    writeProfile('fp2', ['@deepseek-ai/dsh-base', 'dsh-qaq', 'dsh-broken-theme'])
    expect(configFingerprint(profileDir(home, 'fp1'))).not.toBe(configFingerprint(profileDir(home, 'fp2')))
  })

  it('fingerprint changes when the patch layer changes', () => {
    writeProfile('fp3', ['a'])
    writeProfile('fp4', ['a'], '- insert:\n    - id: x\n      name: y\n')
    expect(configFingerprint(profileDir(home, 'fp3'))).not.toBe(configFingerprint(profileDir(home, 'fp4')))
  })

  it('canonicalConfig normalizes missing layers', () => {
    const pr = profileDir(home, 'nocfg')
    mkdirSync(pr, { recursive: true })
    expect(canonicalConfig(pr)).toBe('\u0001')
  })
})

describe('liveBootMatches (verify loaded config before blessing)', () => {
  it('returns match:null when the plugin does not report a fingerprint (offline / older build)', () => {
    writeProfile('web', ['a'])
    writePluginState(null)
    const r = liveBootMatches(home, 'web')
    expect(r.match).toBe(null)
  })

  it('returns match:true when the on-disk config equals what the running DSH loaded', () => {
    writeProfile('web', ['@deepseek-ai/dsh-base', 'dsh-qaq'])
    writePluginState(configFingerprint(profileDir(home, 'web')))
    const r = liveBootMatches(home, 'web')
    expect(r.match).toBe(true)
  })

  it('returns match:false when the on-disk config differs from the loaded one (edit pending a restart)', () => {
    // The running process booted with the OLD (loaded) fingerprint...
    const loadedFp = configFingerprint(profileDir(home, 'web'))
    // ...but the on-disk profile was edited afterwards (a bundle enable).
    writeProfile('web', ['@deepseek-ai/dsh-base', 'dsh-qaq', 'dsh-broken-theme'])
    writePluginState(loadedFp)
    const r = liveBootMatches(home, 'web')
    expect(r.match).toBe(false)
  })
})

describe('recordSuccess verifier gate (guard plan A)', () => {
  it('refuses to bless last-good when the verifier reports match:false', () => {
    // Seed a good baseline first.
    writeProfile('web', ['@deepseek-ai/dsh-base', 'dsh-qaq'])
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'))
    const s0 = readState(home)
    const before = { uiF: s0.profiles['web'].uiFailures, lastGood: s0.profiles['web'].lastGoodSnapshot, autoBefore: listBackups(home, 'auto').length }
    // Now the live disk has a pending (unverified) edit.
    writeProfile('web', ['@deepseek-ai/dsh-base', 'dsh-qaq', 'dsh-broken-theme'])
    const s1 = readState(home)
    s1.profiles['web'].uiFailures = 4
    writeState(home, s1)
    // The verifier says the running DSH loaded an OLDER config -> refuse.
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'), () => ({ match: false, reason: 'disk differs from loaded' }))
    const s2 = readState(home)
    expect(s2.profiles['web'].uiFailures).toBe(4) // counters NOT cleared
    expect(s2.profiles['web'].lastGoodSnapshot).toBe(before.lastGood) // last-good NOT repointed
    expect(listBackups(home, 'auto').length).toBe(before.autoBefore) // no new snapshot
  })

  it('blesses normally when the verifier reports match:true or match:null', () => {
    writeProfile('web', ['@deepseek-ai/dsh-base', 'dsh-qaq'])
    const s = readState(home); const p = profileState(s, 'web'); p.uiFailures = 2
    writeState(home, s)
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'), () => ({ match: true }))
    const after = readState(home)
    expect(after.profiles['web'].uiFailures).toBe(0)
    // null verifier (offline) also blesses, preserving legacy behavior.
    const s3 = readState(home); const p3 = profileState(s3, 'web'); p3.uiFailures = 1
    writeState(home, s3)
    recordSuccess(home, 'web', log, join(profileDir(home, 'web'), 'package.json'), join(profileDir(home, 'web'), 'cordis.patch.yml'), () => ({ match: null }))
    expect(readState(home).profiles['web'].uiFailures).toBe(0)
  })
})
