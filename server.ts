import path from 'node:path'
import { createRequestHandler } from '@react-router/express'
import express from 'express'
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

const app = express()
app.disable('x-powered-by')

// Behind CloudFront the Host header the server sees is the Web Function
// endpoint's domain, not the CloudFront domain the browser uses. React Router
// derives request.url from the host and rejects actions (POST) whose `Origin`
// header doesn't match it. The CloudFront viewer-request function copies the
// viewer's Host into `x-viewer-host` (overwriting anything a client sent), and
// we pin Host/X-Forwarded-Host/-Proto to it; the Express adapter reads them
// when "trust proxy" is enabled (it takes the port from Host, so Host must be
// rewritten too). Client-supplied X-Forwarded-* are dropped otherwise.
app.set('trust proxy', true)
app.use((req, _res, next) => {
  const viewerHost = req.get('x-viewer-host')
  if (viewerHost) {
    req.headers['host'] = viewerHost
    req.headers['x-forwarded-host'] = viewerHost
    req.headers['x-forwarded-proto'] = 'https'
  } else {
    delete req.headers['x-forwarded-host']
    delete req.headers['x-forwarded-proto']
  }
  next()
})

// Static files from the Vite client build. CloudFront caches them, so the
// function only serves each file once per edge location. Hashed files under
// /assets are immutable.
const clientDir = path.join(import.meta.dirname, 'client')
app.use(
  '/assets',
  express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', index: false }),
)
app.use(express.static(clientDir, { maxAge: '1h', index: false }))

app.all('/{*splat}', createRequestHandler({ build }))

const { host, port } = listenAddress()
const server = app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
