# React Router on AWS Lambda Web Functions

A minimal React Router app (v8, server-side rendering) running on an
[AWS Lambda Web Function](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html)
(Node.js 24, arm64). The Web Function can only be reached through CloudFront. Deployment is done
with CloudFormation from GitHub Actions. There is no custom domain: the app is served from the
distribution's `*.cloudfront.net` URL.

The setup is deliberately small. It has no asset bucket, no database, no custom domain and no WAF,
only what it takes to run a website as a Web Function behind CloudFront.

## Architecture

```
Browser ──HTTPS──▶ CloudFront ──SigV4 (OAC)──▶ Web Function endpoint (IamAuth) ──▶ Node HTTP server
                    │                                                               (node:http + React Router)
                    ├─ /assets/*  → CachingOptimized (immutable, served by the function)
                    └─ /*         → dynamic cache policy (TTL 0), AllViewerExceptHostHeader
```

| Resource                                 | Purpose                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `AWS::Lambda::WebFunction`               | The function itself (name and tags only)                                      |
| `AWS::Lambda::WebFunctionRevision`       | Code (`s3://…/versions/<sha>/web.zip`), `nodejs24.x`, role, timeout, env vars |
| `AWS::Lambda::WebFunctionEndpoint`       | HTTPS endpoint, `AuthType: IamAuth`, 100% of traffic to the new revision      |
| `AWS::Lambda::ResourcePolicy`            | Only `cloudfront.amazonaws.com` with `aws:SourceArn` = this distribution      |
| `AWS::CloudFront::OriginAccessControl`   | Type `lambda`, signing behavior `always-amz-auth`, `sigv4`                    |
| `AWS::CloudFront::CachePolicy`           | No caching for HTML; forwards the normalized `Accept-Encoding`                |
| `AWS::CloudFront::ResponseHeadersPolicy` | Removes `lambda-web-request-id` and `lambda-web-logstream`                    |
| `AWS::CloudFront::Distribution`          | Default certificate, no alias                                                 |

All properties of a revision are create-only, so every commit replaces the revision.
CloudFormation creates the new one first, switches the endpoint to it, and then deletes the old one.

## Do you need an adapter?

**No.** A Web Function doesn't receive events. Lambda runs `index.js` from the package root, and
the app starts an ordinary HTTP server on the address in `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`).
Here that is `node:http` with `createRequestListener` from `@remix-run/node-fetch-server` and
`createRequestHandler` from `react-router` ([`server.ts`](server.ts)), without Express or any other
framework. `@remix-run/node-fetch-server` is the package that `@react-router/node` builds on; using
it directly lets the server post-process React Router's fetch `Response` (see compression below).
It is the same setup as on any other Node host. The server loads the handful of files in
`build/client` into memory at startup and serves them from a lookup table, so paths that aren't in
the build never touch the file system.

### Compression

CloudFront only compresses responses that include a `Content-Length` header. React Router streams
SSR HTML with chunked transfer encoding, so it never has one. The server therefore compresses
dynamic responses itself, using Brotli (quality 4) or gzip depending on the `Accept-Encoding`
header that the cache policy forwards. It flushes after every chunk, so streaming keeps working.
CloudFront leaves responses that already have a `Content-Encoding` alone. Static files have a
`Content-Length` and are compressed by CloudFront.

### `@geostrategists/react-router-aws`

This adapter (v3.0.0) does **not** fit Web Functions. It only exports event handlers:
`createAPIGatewayV1RequestHandler`, `createAPIGatewayV2RequestHandler`, `createALBRequestHandler`,
`createFunctionURLRequestHandler` and `createFunctionURLStreamingRequestHandler`. All of them have
the signature `(event, context)` and translate API Gateway, ALB or Function URL events into a fetch
`Request`. A Web Function doesn't call a handler; it talks HTTP to a server listening on a port. The
adapter exists to bridge that gap, and with Web Functions the gap is gone.

### Migrating from a Function URL setup

If your app currently runs on a classic Lambda function with a Function URL behind CloudFront, the
typical workarounds of that setup go away:

- the stub for the Lambda-only `awslambda` global that the adapter needs off Lambda,
- rewriting the host from `x-forwarded-host` so URLs use the public domain,
- a shared-secret header that CloudFront injects and the function checks. OAC with `IamAuth`
  replaces it.

In CloudFormation, `AWS::Lambda::Function` + `AWS::Lambda::Url` + `AWS::Lambda::Permission` become
the three `WebFunction*` resources + `ResourcePolicy` + OAC.

### POST behind CloudFront: `allowedActionOrigins`

CloudFront sends the origin its own hostname as `Host`. React Router builds `request.url` from that
host and rejects actions (POST) whose `Origin` header doesn't match it. Without a countermeasure,
GET requests work but every form submit returns 400.

This app solves it with `allowedActionOrigins: ['*.cloudfront.net']` in
[`react-router.config.ts`](react-router.config.ts), so no CloudFront Function is needed. The exact
distribution domain can't be configured: it is only known after deployment, and passing it in as an
environment variable would create a circular dependency (revision → distribution → endpoint →
revision). That has two consequences:

- Any `*.cloudfront.net` site counts as an allowed origin for POSTs. All other origins are still
  rejected. For this app without login that doesn't matter. With sessions, also use
  `SameSite=Lax` cookies.
- `request.url` contains the Web Function endpoint's hostname, not the CloudFront URL. Relative
  redirects work. Absolute URLs built from the request (canonical links, for example) would be
  wrong.

With a custom domain, list exactly that domain instead, for example
`allowedActionOrigins: ['example.com']`.

## Local development

```sh
npm ci
npm run dev        # Vite dev server with HMR
npm run build      # react-router build + esbuild → dist/ (= deployment package)
npm start          # runs dist/index.js on 127.0.0.1:3000 (or AWS_LAMBDA_HTTP_ENDPOINT)
npm run smoke      # starts dist/index.js like Lambda does; tests GET, assets, POST, foreign origin
npm run check      # format:check + typecheck + build + smoke
```

`dist/` contains only `index.js` (server and React Router build, bundled), `package.json`
(`"type": "module"`) and `client/`. No `node_modules` are shipped.

## Deployment

The workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) works like this:

1. **Check & build** (every push and PR): cfn-lint, `npm run check`, zip `dist/` and upload it as a
   workflow artifact.
2. **Deploy** (`main` only, or manually via `workflow_dispatch`):
   - Upload `web.zip` to `s3://react-router-web-function-artifacts-<account-id>/versions/<sha>/`.
     The bucket is created if needed. A Web Function revision doesn't copy the code; Lambda reads it
     straight from the bucket. That's why the bucket is versioned and a bucket policy allows the
     Lambda service (`lambda.amazonaws.com`, from this account only) `s3:GetObject` and
     `s3:GetObjectVersion` on `versions/*`. Don't delete packages that a live revision still uses.
   - Deploy the stack `react-router-web-function` to **eu-west-1**.
   - Smoke test through the CloudFront URL: SSR on arm64, compression, stripped Lambda headers,
     assets, POST, foreign origin.
   - Check that a direct request to the Web Function endpoint returns **403**.

The CloudFront URL is shown in the job summary and in the stack outputs (`DistributionUrl`).

### Setup

- Repository variable `AWS_ACCESS_KEY_ID` and secret `AWS_SECRET_ACCESS_KEY`.
- The IAM user needs permissions for CloudFormation, `lambda:*WebFunction*`,
  `lambda:PutResourcePolicy`, `GetResourcePolicy` and `DeleteResourcePolicy`, plus
  `iam:CreateRole`/`PassRole`, CloudFront, CloudWatch Logs, S3 (including `s3:PutBucketVersioning`,
  `s3:PutBucketPolicy` and `s3:GetObjectVersion`) and `sts:GetCallerIdentity`.
- If the very first deploy fails, the stack ends up in `ROLLBACK_COMPLETE`. CloudFormation can't
  update a stack in that state, so delete it before the next attempt.

### Region

At launch, Web Functions are available in us-east-1, us-east-2, us-west-2, ap-northeast-1 and
**eu-west-1**. The workflow uses eu-west-1; change `AWS_REGION` in the workflow to pick another
supported region.

### Teardown

The workflow [`.github/workflows/destroy.yml`](.github/workflows/destroy.yml) deletes the whole
stack. Run it from the Actions tab ("Destroy stack" → "Run workflow") and type the stack name
`react-router-web-function` to confirm. It waits until the deletion has finished; the CloudFront
distribution alone can take several minutes to disable and delete. The artifacts bucket isn't part
of the stack and is kept.
