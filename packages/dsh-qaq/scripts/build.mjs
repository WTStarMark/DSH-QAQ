import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
// Optional --outdir stays in sync with the default 'lib' unless overridden,
// so scripts/check-plugin-lib.mjs can regenerate into a throwaway dir.
const outdir = process.argv.includes('--outdir') ? process.argv[process.argv.indexOf('--outdir') + 1] : join(root, 'lib')
mkdirSync(outdir, { recursive: true })
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: false, platform: 'node', format: 'esm', target: 'es2022', sourcemap: false, logLevel: process.argv.includes('--quiet') ? 'silent' : 'info',
})
// Emit a declaration file for the plugin's public surface. Authored here (not
// tsc --declaration) so the zero-runtime-dependency .d.ts never pulls in the
// full @deepseek-ai package: Context is referenced as an optional-peer type
// only, mirroring package.json's peerDependenciesMeta.
const dts = `import type { Context } from '@deepseek-ai/cordis'
/** dsh-qaq plugin identity (bundle patch entry id). */
export declare const name: string
/** Apply the plugin: wait for the host loader tree to settle, then snapshot
 * the profile's startup config. Best-effort and backup-only. */
export declare function apply(ctx: Context): void
`
writeFileSync(join(outdir, 'index.d.ts'), dts, 'utf8')
console.log('dsh-qaq built -> ' + join(outdir, 'index.js') + ' + index.d.ts')
