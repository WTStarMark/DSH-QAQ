#!/usr/bin/env node
// qaq smoke: unit tests + a quick isolated-home integration check.
import { spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const tmp = fileURLToPath(new URL('./.smoke-home', import.meta.url))
const clone = process.env.QAQ_SMOKE_DSH_HOME || join(root, 'deepseek-harness')
let failed = false

function run(cmd, args, opts) {
  opts = opts || {}
  console.log('\n> ' + cmd + ' ' + args.join(' ') + (opts.cwd ? '  (cwd=' + opts.cwd + ')' : ''))
  // On Windows, `npx`/`node` resolve via .cmd/.exe shims that child_process only
  // finds with a shell; on POSIX spawn directly.
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) { failed = true; console.error('[smoke] FAILED: ' + cmd + ' ' + args.join(' ')) }
  return r.status === 0
}
function isDir(p) { try { return statSync(p).isDirectory() } catch { return false } }

console.log('===== QAQ smoke =====')

// 1. Unit tests.
run('npx', ['vitest', 'run'])

// 2. Isolated home: seed a good snapshot, then break config.
rmSync(tmp, { recursive: true, force: true })
mkdirSync(join(tmp, 'profiles', 'web'), { recursive: true })
writeFileSync(join(tmp, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'smoke', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
writeFileSync(join(tmp, 'profiles', 'web', 'cordis.patch.yml'), '[]')

console.log('[smoke] seeding good snapshot...')
run('node', ['--import', 'tsx/esm', cli, 'backup', '--profile', 'web'], { env: { DSH_HOME: tmp } })

writeFileSync(join(tmp, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: nope\n      name: does-not-exist-xyz\n')
console.log('[smoke] broken profile written')

console.log('[smoke] running guard once...')
if (!isDir(join(clone, 'apps'))) {
  console.warn('[smoke] SKIP real-DSH integration: checkout not found at ' + clone + ' (set QAQ_SMOKE_DSH_HOME)')
} else {
  run('node', ['--import', 'tsx/esm', cli, 'dsh', 'web', '--port', '3090', '--yes', '--cwd', clone, '--ui-timeout', '15000', '--confirm-ms', '3000'],
    { env: { DSH_HOME: tmp, QAQ_DSH_CMD: 'node --import tsx/esm apps/cli/src/bin.ts web' }, cwd: clone })
  console.log('[smoke] integration complete')
}
rmSync(tmp, { recursive: true, force: true })

if (failed) { console.error('===== QAQ smoke FAILED ====='); process.exit(1) }
console.log('===== QAQ smoke PASSED =====')
process.exit(0)
