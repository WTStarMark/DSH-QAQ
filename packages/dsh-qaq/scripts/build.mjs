import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: false, platform: 'node', format: 'esm', target: 'es2022', sourcemap: false, logLevel: 'info',
})
console.log('dsh-qaq built -> lib/index.js')
