import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseStatusPorcelain, tagVersion, pickLatestDshTag, fetchDshLatestTag, checkDshUpdate,
  planDshUpdate, applyDshUpdate, isGitCheckout,
} from '../src/dsh-update.ts'
import type { Git, Cmd, DshUpdatePlan } from '../src/dsh-update.ts'

function stageCheckout(version = '0.1.0-rc.5'): string {
  const dir = mkdtempSync(join(tmpdir(), 'qaq-dshupd-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version }), 'utf8')
  return dir
}

/** A programmable fake git runner. Records calls for assertions. */
function fakeGit(overrides: Record<string, (args: string[]) => { ok: boolean; stdout?: string; stderr?: string }>): { git: Git; calls: string[][] } {
  const calls: string[][] = []
  const git: Git = async (_cwd, args) => {
    calls.push(args)
    const key = args[0]
    const hit = overrides[key]
    if (hit) {
      const r = hit(args)
      return { ok: r.ok, code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
    return { ok: true, code: 0, stdout: '', stderr: '' }
  }
  return { git, calls }
}

function fakeCmd(plan: { success: boolean[] }): { cmd: Cmd; calls: string[][] } {
  const calls: string[][] = []
  let i = 0
  const cmd: Cmd = async (_cwd, args) => {
    calls.push(args)
    const ok = plan.success[Math.min(i, plan.success.length - 1)] ?? true
    i++
    return { ok, code: ok ? 0 : 1, stdout: '', stderr: ok ? '' : 'boom' }
  }
  return { cmd, calls }
}

describe('parseStatusPorcelain', () => {
  it('splits modified vs untracked', () => {
    const out = ' M pnpm-lock.yaml\n?? .env\nA  apps/cli/src/bin.ts\n'
    const p = parseStatusPorcelain(out)
    expect(p.modified).toEqual(['pnpm-lock.yaml', 'apps/cli/src/bin.ts'])
    expect(p.untracked).toEqual(['.env'])
  })
})

describe('tagVersion / pickLatestDshTag', () => {
  it('strips the dsh-v prefix only for matching tags', () => {
    expect(tagVersion('dsh-v0.1.1-rc.1')).toBe('0.1.1-rc.1')
    expect(tagVersion('other')).toBeNull()
  })

  it('picks the newest by full semver incl. rc chains', () => {
    const entries = [
      { name: 'dsh-v0.1.0-rc.7' },
      { name: 'dsh-v0.1.0-rc.8' },
      { name: 'dsh-v0.1.1-rc.1' },
      { name: 'not-a-dsh-tag' },
      { name: 'something-v9.9.9' },
    ]
    expect(pickLatestDshTag(entries)).toBe('dsh-v0.1.1-rc.1')
  })
})

describe('fetchDshLatestTag', () => {
  it('resolves the newest tag from the GitHub payload', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify([
      { name: 'dsh-v0.1.0-rc.8' }, { name: 'dsh-v0.1.1-rc.1' }, { name: 'dsh-v0.1.0-rc.7' },
    ]), { status: 200 })) as unknown as typeof fetch
    const r = await fetchDshLatestTag({ fetchImpl })
    expect(r.ok).toBe(true)
    expect(r.tag).toBe('dsh-v0.1.1-rc.1')
    expect(r.version).toBe('0.1.1-rc.1')
  })

  it('fails cleanly on HTTP errors and empty payloads', async () => {
    const bad = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    expect((await fetchDshLatestTag({ fetchImpl: bad })).ok).toBe(false)
    const empty = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
    const r = await fetchDshLatestTag({ fetchImpl: empty })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no dsh-vX')
  })
})

describe('checkDshUpdate', () => {
  const tags = (async () => new Response(JSON.stringify([{ name: 'dsh-v0.1.1-rc.1' }]), { status: 200 })) as unknown as typeof fetch

  it('reports an update when the remote tag is newer (rc-aware)', async () => {
    const r = await checkDshUpdate({ fetchImpl: tags, version: '0.1.0-rc.5' })
    expect(r.ok).toBe(true)
    expect(r.updateAvailable).toBe(true)
    expect(r.latestTag).toBe('dsh-v0.1.1-rc.1')
  })

  it('reports up-to-date for equal rc', async () => {
    const r = await checkDshUpdate({ fetchImpl: tags, version: '0.1.1-rc.1' })
    expect(r.ok).toBe(true)
    expect(r.updateAvailable).toBe(false)
  })

  it('reads the local version from the checkout when no override', async () => {
    const dir = stageCheckout('0.1.0-rc.5')
    try {
      const r = await checkDshUpdate({ fetchImpl: tags, checkout: dir })
      expect(r.current).toBe('0.1.0-rc.5')
      expect(r.updateAvailable).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('isGitCheckout', () => {
  it('accepts dir and gitfile forms, rejects plain dirs', () => {
    const dir = stageCheckout('0.1.0-rc.5')
    try { expect(isGitCheckout(dir)).toBe(true) } finally { rmSync(dir, { recursive: true, force: true }) }
    const plain = mkdtempSync(join(tmpdir(), 'plain-'))
    try { expect(isGitCheckout(plain)).toBe(false) } finally { rmSync(plain, { recursive: true, force: true }) }
  })
})

describe('planDshUpdate', () => {
  it('refuses non-git checkouts', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'))
    const home = mkdtempSync(join(tmpdir(), 'qaq-home-'))
    try {
      const p = await planDshUpdate({ home, profile: 'web', checkout: plain, targetTag: 'dsh-v0.1.1-rc.1' })
      expect(p.ok).toBe(false)
      expect(p.reason).toContain('git checkout')
    } finally { rmSync(plain, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('refuses while DSH is running', async () => {
    const dir = stageCheckout('0.1.0-rc.5')
    const home = mkdtempSync(join(tmpdir(), 'qaq-home-'))
    try {
      const p = await planDshUpdate({ home, profile: 'web', checkout: dir, targetTag: 'dsh-v0.1.1-rc.1', isDshRunning: async () => true })
      expect(p.ok).toBe(false)
      expect(p.reason).toContain('running')
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('refuses a tag the checkout does not have locally', async () => {
    const dir = stageCheckout('0.1.0-rc.5')
    const home = mkdtempSync(join(tmpdir(), 'qaq-home-'))
    try {
      const { git } = fakeGit({ 'rev-parse': () => ({ ok: false, stderr: 'unknown revision' }) })
      const p = await planDshUpdate({ home, profile: 'web', checkout: dir, targetTag: 'dsh-v0.99.0', git, isDshRunning: async () => false })
      expect(p.ok).toBe(false)
      expect(p.reason).toContain('not present')
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })

  it('plans successfully and archives the lossless snapshot', async () => {
    const dir = stageCheckout('0.1.0-rc.5')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfile: 9\n', 'utf8')
    const home = mkdtempSync(join(tmpdir(), 'qaq-home-'))
    try {
      const { git } = fakeGit({
        'rev-parse': (args) => {
          if (args.includes('--verify')) return { ok: true, stdout: '528c682e06' }
          if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'master' }
          return { ok: true, stdout: '47f943859b' }
        },
        'status': () => ({ ok: true, stdout: ' M pnpm-lock.yaml' }),
        'diff': () => ({ ok: true, stdout: '--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-lockfile-version: 9\n+lockfile-version: 9.1' }),
      })
      const p = await planDshUpdate({ home, profile: 'web', checkout: dir, targetTag: 'dsh-v0.1.1-rc.1', git, isDshRunning: async () => false })
      expect(p.ok).toBe(true)
      expect(p.currentVersion).toBe('0.1.0-rc.5')
      expect(p.currentRef).toBe('47f943859b')
      expect(p.currentBranch).toBe('master')
      expect(p.targetVersion).toBe('0.1.1-rc.1')
      expect(p.modified).toEqual(['pnpm-lock.yaml'])
      expect(p.backupDir).toBeTruthy()
      expect(existsSync(join(p.backupDir!, 'plan.json'))).toBe(true)
      expect(existsSync(join(p.backupDir!, 'status.txt'))).toBe(true)
      const changes = readdirSync(join(p.backupDir!, 'changes'))
      expect(changes.length).toBe(1)
      expect(readFileSync(join(p.backupDir!, 'changes', changes[0]), 'utf8')).toContain('lockfile-version')
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
  })
})

function makePlan(over: Partial<DshUpdatePlan> = {}): DshUpdatePlan {
  return {
    ok: true, checkout: stageCheckoutTarget(), currentVersion: '0.1.0-rc.5',
    currentRef: '47f943859b', currentBranch: 'master',
    targetTag: 'dsh-v0.1.1-rc.1', targetVersion: '0.1.1-rc.1',
    backupDir: '/tmp/fake-backup', modified: [], untracked: [], archiveFiles: 0,
    ...over,
  }
}

function stageCheckoutTarget(): string {
  return mkdtempSync(join(tmpdir(), 'qaq-target-'))
}

describe('applyDshUpdate', () => {
  it('switches → installs → builds → verifies (success)', async () => {
    const dir = stageCheckoutTarget()
    try {
      const { git } = fakeGit({})
      const { cmd } = fakeCmd({ success: [true, true] })
      const plan = makePlan({ checkout: dir })
      const out = await applyDshUpdate({ plan, git, cmd, versionOf: () => '0.1.1-rc.1' })
      expect(out.ok).toBe(true)
      expect(out.stage).toBe('done')
      expect(out.finalVersion).toBe('0.1.1-rc.1')
      expect(out.rolledBack).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('stashes local tracked modifications before switching', async () => {
    const dir = stageCheckoutTarget()
    try {
      const { git, calls } = fakeGit({})
      const stored: string[][] = []
      const gitProbe: Git = async (cwd, args) => {
        stored.push(args)
        return git(cwd, args)
      }
      const { cmd } = fakeCmd({ success: [true, true] })
      const plan = makePlan({ checkout: dir, modified: ['pnpm-lock.yaml'] })
      const out = await applyDshUpdate({ plan, git: gitProbe, cmd, versionOf: () => '0.1.1-rc.1' })
      expect(out.ok).toBe(true)
      expect(stored.some((a) => a[0] === 'stash' && a.includes('pnpm-lock.yaml'))).toBe(true)
      // stash happened BEFORE checkout
      const iStash = stored.findIndex((a) => a[0] === 'stash')
      const iCheckout = stored.findIndex((a) => a[0] === 'checkout')
      expect(iStash).toBeGreaterThan(-1)
      expect(iCheckout).toBeGreaterThan(iStash)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rolls back when the version verify fails', async () => {
    const dir = stageCheckoutTarget()
    try {
      const { git, calls } = fakeGit({})
      const { cmd } = fakeCmd({ success: [true, true] })
      const plan = makePlan({ checkout: dir })
      const out = await applyDshUpdate({ plan, git, cmd, versionOf: () => '0.0.0', restoreDepsOnRollback: false })
      expect(out.ok).toBe(false)
      expect(out.rolledBack).toBe(true)
      expect(out.stage).toBe('rolled-back')
      const rb = calls.find((a) => a[0] === 'checkout' && a[1] === '--force')
      expect(rb).toBeTruthy()
      expect(rb![2]).toBe('47f943859b')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rolls back on an install failure', async () => {
    const dir = stageCheckoutTarget()
    try {
      const { git, calls } = fakeGit({})
      const { cmd } = fakeCmd({ success: [false, true] })
      const plan = makePlan({ checkout: dir })
      const out = await applyDshUpdate({ plan, git, cmd, restoreDepsOnRollback: false })
      expect(out.ok).toBe(false)
      expect(out.rolledBack).toBe(true)
      expect(out.detail).toContain('pnpm install failed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('recovers a failed checkout by popping the stash (rollback path)', async () => {
    const dir = stageCheckoutTarget()
    try {
      const calls: string[][] = []
      const git: Git = async (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'checkout') return { ok: false, code: 1, stdout: '', stderr: 'would overwrite' }
        if (args[0] === 'stash') return { ok: true, code: 0, stdout: '', stderr: '' }
        return { ok: true, code: 0, stdout: '', stderr: '' }
      }
      const { cmd } = fakeCmd({ success: [true] })
      const plan = makePlan({ checkout: dir, modified: ['pnpm-lock.yaml'] })
      const out = await applyDshUpdate({ plan, git, cmd, restoreDepsOnRollback: false })
      expect(out.ok).toBe(false)
      expect(out.rolledBack).toBe(true)
      // stash pop was attempted after the failed checkout
      expect(calls.some((a) => a[0] === 'stash' && a[1] === 'pop')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not retry a frozen install by default (conservative)', async () => {
    const dir = stageCheckoutTarget()
    try {
      const { git } = fakeGit({})
      const { cmd, calls } = fakeCmd({ success: [false] })
      const plan = makePlan({ checkout: dir })
      const out = await applyDshUpdate({ plan, git, cmd, restoreDepsOnRollback: false })
      expect(out.ok).toBe(false)
      expect(calls.some((a) => a[0] === 'install' && !a.includes('--frozen-lockfile'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
