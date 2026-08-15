/**
 * dsh-qaq — QAQ backup plugin. Mounts in a DSH profile, waits for the host
 * loader tree to settle, then snapshots the profile's startup config (the
 * package.json bundle list + cordis.patch.yml) into ~/.dsh/.qaq/latest-good
 * and history/. Backup-only: it never detects failure, never rolls back, and
 * changes no DSH behavior.
 */
import { join } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'dsh-qaq'

const QAQ_DIR = '.qaq'
const KEEP = 5
const FILES = ['package.json', 'cordis.patch.yml'] as const

function newTimestamp(): string { return new Date().toISOString().replace(/[:.]/g, '-') }

function prune(historyDir: string, keep: number): void {
  let names: string[]
  try { names = readdirSync(historyDir) } catch { return }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const n of names.slice(keep)) {
    try { rmSync(join(historyDir, n), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function writeSnapshotHome(home: string, profileName: string, profileDir: string): void {
  const root = join(home, QAQ_DIR)
  mkdirSync(join(root, 'latest-good'), { recursive: true })
  mkdirSync(join(root, 'history'), { recursive: true })
  const ts = newTimestamp()
  mkdirSync(join(root, 'history', ts), { recursive: true })
  for (const f of FILES) {
    const src = join(profileDir, f)
    if (existsSync(src)) {
      copyFileSync(src, join(root, 'latest-good', f))
      copyFileSync(src, join(root, 'history', ts, f))
    }
  }
  writeFileSync(join(root, 'latest-good', 'manifest.json'), JSON.stringify({ profile: profileName, ts: new Date().toISOString() }, null, 2), 'utf8')
  prune(join(root, 'history'), KEEP)
}

/**
 * Wait for the loader tree to settle, then snapshot the profile config.
 * A failed boot (rejected settle) is not snapshoted.
 */
export function apply(ctx: Context): void {
  const home = resolveDshHome()
  const profileName = process.env.QAQ_PROFILE ?? inferProfileName(ctx) ?? 'web'
  const profileDir = join(home, 'profiles', profileName)
  const settle = ctx.get('loader')?.await?.()
  if (settle === undefined) {
    if (existsSync(join(profileDir, 'package.json'))) writeSnapshotHome(home, profileName, profileDir)
    return
  }
  void settle.then(() => {
    if (existsSync(join(profileDir, 'package.json'))) writeSnapshotHome(home, profileName, profileDir)
  }).catch(() => { /* do not snapshot a failed boot */ })
}

/** Best-effort: derive the active profile name from the working directory if it
 * sits under a profiles/<name> dir. */
function inferProfileName(ctx: Context): string | null {
  const cwd = (process.env.INIT_CWD ?? process.cwd())
  const m = cwd.match(/profiles[\\/]([^\\/]+)/)
  return m ? m[1] : null
}