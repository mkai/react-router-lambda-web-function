// Bundles server.ts plus the React Router server build into a single
// dist/index.js and copies the client build next to it. dist/ is exactly the
// Web Function deployment package: Lambda runs index.js at the package root,
// so no node_modules are needed at runtime.
import { cp, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })

await build({
  entryPoints: ['server.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  alias: {
    'virtual:react-router/server-build': './build/server/index.js',
  },
  define: {
    // React and React Router pick their production builds from this.
    'process.env.NODE_ENV': '"production"',
  },
  // react-dom/server is CommonJS and calls require() for Node built-ins
  // (util, stream, …); give the ESM bundle a real require().
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})

// index.js is ESM; mark the package as such so Node loads it as a module.
await writeFile('dist/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
await cp('build/client', 'dist/client', { recursive: true })
