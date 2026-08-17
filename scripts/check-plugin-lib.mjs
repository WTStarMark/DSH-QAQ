#!/usr/bin/env node
/**
 * Verify the checked-in / present dsh-qaq plugin build artifacts (lib/) are in
 * sync with its source (packages/dsh-qaq/src). Regenerates the plugin build
 * into a sibling directory and byte-compares with lib/.
 *
 * Run in CI after `pnpm build` so a stale lib/index.js (the P1 regression:
 * the committed build artifact drifted from src, silently killing `qaq watch`
 * discovery) is caught immediately instead of shipping to users.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..', 'packages', 'dsh-qaq')
const libDir = join(pkgRoot, 'lib')
const checkDir = join(pkgRoot, 'lib.check')

const files = ['index.js', 'index.d.ts']

function fail(msg) {
  console.error('[check-plugin-lib][31m' + msg + '[0m')
  process.exit(1)
}

// Regenerate into lib.check.
rmSync(checkDir, { recursive: true, force: true })
mkdirSync(checkDir, { recursive: true })
try {
  execFileSync(process.execPath, [join(pkgRoot, 'scripts', 'build.mjs'), '--outdir', checkDir, '--quiet'], {
    cwd: pkgRoot, stdio: 'inherit',
  })
} catch {
  fail('plugin build failed while generating check copy')
}

for (const f of files) {
  const target = join(libDir, f)
  const fresh = join(checkDir, f)
  if (!existsSync(target)) { fail('lib/' + f + ' is missing — run pnpm build (regenerates the plugin lib)') }
  const a = readFileSync(target, 'utf8')
  const b = readFileSync(fresh, 'utf8')
  if (a !== b) {
    fail('lib/' + f + ' is STALE (differs from regenerated source) — run pnpm build and commit the regenerated lib')
  }
}
rmSync(checkDir, { recursive: true, force: true })
console.log('[32m[check-plugin-lib] plugin lib is in sync with src[0m')
