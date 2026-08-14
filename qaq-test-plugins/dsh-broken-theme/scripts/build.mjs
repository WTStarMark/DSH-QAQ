import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'lib')
const ID = 'dsh-broken-theme'
await mkdir(dist, { recursive: true })

const FACTORY_BANNER = [
  'window.__ModuleLoader__.load({',
  '  id: ' + JSON.stringify(ID) + ',',
  '  factory: (require) => {',
  'var module = { exports: {} };',
  'var exports = module.exports;',
].join('\n')
const FACTORY_FOOTER = ['return module.exports;', '  } });'].join('\n')

await build({ entryPoints: [join(root, 'src/index.ts')], outfile: join(dist, 'index.js'), bundle: false, platform: 'node', format: 'esm', target: 'es2022', sourcemap: false, logLevel: 'info' })
await build({ entryPoints: [join(root, 'src/client/index.ts')], outfile: join(dist, 'client.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: true, logLevel: 'info', banner: { js: FACTORY_BANNER }, footer: { js: FACTORY_FOOTER } })
console.log('dsh-broken-theme build complete')
