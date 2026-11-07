import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { createRequestListener } from '@react-router/node'
// Resolved by Vite's typegen for type-checking and aliased to
// ./build/server/index.js by scripts/bundle.mjs, so the React Router server
// build ends up inside the single bundled dist/index.js.
import * as build from 'virtual:react-router/server-build'

// Lambda Web Functions run a plain HTTP server: Lambda picks the address and
// passes it as "host:port" in AWS_LAMBDA_HTTP_ENDPOINT. Off Lambda (local
// testing) fall back to HOST/PORT.
function listenAddress(): { host: string; port: number } {
  const endpoint = process.env['AWS_LAMBDA_HTTP_ENDPOINT']
  if (endpoint) {
    const separator = endpoint.lastIndexOf(':')
    const port = Number(endpoint.slice(separator + 1))
    if (separator <= 0 || !Number.isInteger(port)) {
      throw new Error(`Invalid AWS_LAMBDA_HTTP_ENDPOINT: ${endpoint}`)
    }
    return { host: endpoint.slice(0, separator), port }
  }
  return { host: process.env['HOST'] ?? '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) }
}

type StaticFile = { body: Buffer; contentType: string; cacheControl: string }

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// The Vite client build is small, so load it into memory once at startup and
// serve it from a lookup table keyed by URL path. Only files that exist in the
// build can match, which rules out path traversal. CloudFront caches these,
// so the function serves each file roughly once per edge location.
function loadStaticFiles(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue
    }
    const filePath = path.join(entry.parentPath, entry.name)
    const urlPath = `/${path.relative(dir, filePath).split(path.sep).join('/')}`
    if (urlPath.startsWith('/.vite/')) {
      continue
    }
    files.set(urlPath, {
      body: readFileSync(filePath),
      contentType: CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      // Hashed Vite output under /assets never changes; everything else may.
      cacheControl: urlPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    })
  }
  return files
}

const staticFiles = loadStaticFiles(path.join(import.meta.dirname, 'client'))

function serveStaticFile(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false
  }
  const file = staticFiles.get(new URL(req.url ?? '/', 'http://localhost').pathname)
  if (!file) {
    return false
  }
  res.writeHead(200, {
    'content-type': file.contentType,
    'content-length': file.body.length,
    'cache-control': file.cacheControl,
  })
  res.end(req.method === 'HEAD' ? undefined : file.body)
  return true
}

const handleRequest = createRequestListener({ build })

const server = createServer((req, res) => {
  if (!serveStaticFile(req, res)) {
    void handleRequest(req, res)
  }
})

const { host, port } = listenAddress()
server.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
