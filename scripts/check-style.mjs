#!/usr/bin/env node
/**
 * Dependency-free style gate for QAQ (no eslint/prettier needed — the repo
 * pins a frozen lockfile, so it cannot pull new dev deps at install time).
 * Checks over the source tree:
 *   - trailing whitespace
 *   - literal tab characters (QAQ indents with 2 spaces)
 *   - TODO / FIXME / HACK / XXX / @ts-ignore / @ts-expect-error markers
 *   - missing final newline
 * Plain node:fs only — no child processes, no network, no deps.
 * Exit code 1 on any violation. Run via `pnpm lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CODE_EXT = new Set(['.ts', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml'])
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'img',
  'qaq-test-home', 'qaq-clean-home', 'qaq-loop-home', 'qaq-rollback-test-home',
  'qaq-chrome-profile', 'qaq-plugin-home', 'deepseek-harness', '.pnpm-store',
])
const MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b|@ts-ignore|@ts-expect-error|eslint-disable/

const problems = []
let scanned = 0

function checkFile(file, skipMarkers = false) {
  const buf = readFileSync(file)
  scanned++
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const n = i + 1
    const rel = relative(root, file)
    if (/[ \t]+$/.test(line)) problems.push(`${rel}:${n}: trailing whitespace`)
    if (line.includes('\t')) problems.push(`${rel}:${n}: tab character (use spaces)`)
    if (!skipMarkers && MARKER_RE.test(line)) problems.push(`${rel}:${n}: style marker: ${MARKER_RE.exec(line)[0]}`)
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
    problems.push(`${relative(root, file)}: missing final newline`)
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
    } else if (entry.isFile() && CODE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      // This script documents the marker list in its header — skip the marker
      // check on itself (whitespace/tab/newline checks still apply).
      checkFile(join(dir, entry.name), entry.name === 'check-style.mjs')
    }
  }
}

walk(root)
// Root-level code files not reached by walk()'s dir scan (walk visits dirs only).
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && CODE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
    checkFile(join(root, entry.name), entry.name === 'check-style.mjs')
  }
}

if (problems.length) {
  for (const p of problems) console.error('[style] ' + p)
  console.error(`[style] ${problems.length} problem(s) across ${scanned} file(s).`)
  process.exit(1)
}
console.log(`[style] ok — ${scanned} file(s) checked.`)
