// End-to-end smoke test for the bundled Web Function server.
//
//   node scripts/smoke.mjs                          # starts dist/index.js locally
//   node scripts/smoke.mjs https://dxxxx.cloudfront.net   # tests a deployment
//
// Locally the server is started the way Lambda starts it: with the listen
// address in AWS_LAMBDA_HTTP_ENDPOINT. Form submits then send an Origin of a
// made-up CloudFront domain, which differs from the host the server sees,
// exactly as behind CloudFront.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const remoteBaseUrl = process.argv[2]

let server
let baseUrl = remoteBaseUrl

if (!remoteBaseUrl) {
  const address = '127.0.0.1:9321'
  baseUrl = `http://${address}`
  server = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, AWS_LAMBDA_HTTP_ENDPOINT: address },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await waitForServer(baseUrl)
}

const publicOrigin = remoteBaseUrl
  ? new URL(remoteBaseUrl).origin
  : 'https://d1234example.cloudfront.net'

async function waitForServer(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'HEAD' })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Server at ${url} did not start within 10s`)
}

// Index route actions are addressed with ?index, exactly like <Form> does.
const actionUrl = () => new URL('/?index', baseUrl)

async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

try {
  let html = ''

  await check('GET / renders on the server', async () => {
    const response = await fetch(baseUrl)
    assert.equal(response.status, 200)
    html = await response.text()
    assert.match(html, /data-testid="rendered-at"/)
    assert.match(html, /Node\.js .*v24\./)
    const runtime = /data-testid="runtime">(.*?)<\/dd>/.exec(html)?.[1]?.replaceAll('<!-- -->', '')
    console.log(`     runtime: ${runtime}`)
    if (remoteBaseUrl) {
      assert.match(runtime ?? '', / on arm64 in /)
      // CloudFront compresses the HTML and strips Lambda's internal headers.
      assert.match(response.headers.get('content-encoding') ?? '', /^(br|gzip)$/)
      assert.equal(response.headers.get('lambda-web-request-id'), null)
      assert.equal(response.headers.get('lambda-web-logstream'), null)
    }
    // Behind CloudFront this is the Web Function endpoint's hostname.
    console.log(
      `     request URL seen by server: ${/data-testid="request-url">(.*?)<\/dd>/.exec(html)?.[1]}`,
    )
  })

  await check('GET /assets/* is served with immutable caching', async () => {
    const asset = /href="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    assert.ok(asset, 'no /assets/*.js link in the HTML')
    const response = await fetch(new URL(asset, baseUrl))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /immutable/)
  })

  await check('POST /?index from the CloudFront origin runs the action', async () => {
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: {
        origin: publicOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ name: 'Smoke' }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Hello Smoke!/)
  })

  await check('POST /?index from a foreign origin is rejected', async () => {
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ name: 'Mallory' }),
    })
    assert.equal(response.status, 400)
  })
} finally {
  server?.kill('SIGTERM')
}
