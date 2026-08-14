#!/usr/bin/env node
// qaq bin — run the built dist bundle if present, else run the tsx source through
// tsx's ESM loader. Converts local paths to file:// URLs for ESM import.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
const __dir = dirname(fileURLToPath(import.meta.url))
const dist = join(__dir, '..', 'dist', 'qaq.mjs')
try {
  if (existsSync(dist)) {
    await import(pathToFileURL(dist).href)
  } else {
    await import('tsx/esm')
    await import(pathToFileURL(join(__dir, '..', 'src', 'cli.ts')).href)
  }
} catch (e) {
  console.error('[qaq] failed to start:', e)
  process.exit(1)
}
