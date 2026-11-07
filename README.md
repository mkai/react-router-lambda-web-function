# React Router auf AWS Lambda Web Functions

Minimale React-Router-App (v8, SSR) auf einer
[AWS Lambda Web Function](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html)
(Node.js 24, arm64). Die Web Function ist nur über CloudFront erreichbar. Deployt wird per
CloudFormation aus GitHub Actions. Es gibt keine eigene Domain, die App läuft unter der
`*.cloudfront.net`-URL der Distribution.

Vorlage war das Fetchbot-Repository (`cloudformation.yaml`, `.github/workflows/ci.yml`,
`apps/web`). Alles, was für diesen Test nicht nötig ist, ist weggelassen: Monorepo, S3-Bucket für
Assets, API, DynamoDB, Basic Auth, WAF, Route 53 und ACM.

## Architektur

```
Browser ──HTTPS──▶ CloudFront ──SigV4 (OAC)──▶ Web Function Endpoint (IamAuth) ──▶ Node-HTTP-Server
                    │                                                               (Express + React Router)
                    ├─ /assets/*  → CachingOptimized (immutable, vom Server ausgeliefert)
                    └─ /*         → CachingDisabled, AllViewerExceptHostHeader, viewer-request function
```

| Ressource                              | Zweck                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `AWS::Lambda::WebFunction`             | Die Funktion selbst (nur Name/Tags)                                       |
| `AWS::Lambda::WebFunctionRevision`     | Code (`s3://…/versions/<sha>/web.zip`), `nodejs24.x`, Rolle, Timeout, Env |
| `AWS::Lambda::WebFunctionEndpoint`     | HTTPS-Endpoint, `AuthType: IamAuth`, 100 % Traffic auf die neue Revision  |
| `AWS::Lambda::ResourcePolicy`          | Nur `cloudfront.amazonaws.com` mit `aws:SourceArn` = diese Distribution   |
| `AWS::CloudFront::OriginAccessControl` | Typ `lambda`, Signing `always-amz-auth`, `sigv4`                          |
| `AWS::CloudFront::Function`            | Gibt den Viewer-Host als `x-viewer-host` an den Server weiter             |
| `AWS::CloudFront::Distribution`        | Default-Zertifikat, kein Alias                                            |

Weil alle Properties einer Revision create-only sind, ersetzt jeder Commit die Revision.
CloudFormation legt zuerst die neue an, schaltet den Endpoint um und löscht die alte danach.

## Brauchen wir einen Adapter?

**Nein.** Eine Web Function bekommt keine Events. Lambda startet `index.js` aus dem Paket-Root,
und die App muss einen ganz normalen HTTP-Server auf der Adresse aus `AWS_LAMBDA_HTTP_ENDPOINT`
(`host:port`) starten. Hier ist das ein kleiner Express-Server
([`server.ts`](server.ts)) mit dem offiziellen `@react-router/express`-Handler. Das ist dasselbe
Setup wie bei jedem anderen Node-Hosting.

### `@geostrategists/react-router-aws`

Der Adapter (v3.0.0) passt **nicht** zu Web Functions. Er exportiert nur Event-Handler:
`createAPIGatewayV1RequestHandler`, `createAPIGatewayV2RequestHandler`, `createALBRequestHandler`,
`createFunctionURLRequestHandler` und `createFunctionURLStreamingRequestHandler`. Alle haben die
Signatur `(event, context)` und übersetzen API-Gateway-, ALB- oder Function-URL-Events in einen
Fetch-`Request`. Eine Web Function ruft aber keinen Handler auf, sondern spricht HTTP mit einem
Server, der auf einem Port lauscht. Den Adapter gibt es nur, um diese Lücke zu schließen, und bei
Web Functions gibt es sie nicht mehr.

Damit entfallen auch die Workarounds aus Fetchbot:

- der `awslambda`-Global-Stub in `build.lambda.mjs`,
- `getHost` mit `x-forwarded-host`,
- `setDefaultCacheControl`,
- der `x-origin-secret`-Check. Den ersetzen OAC und `IamAuth`.

Für Fetchbot heißt das: `apps/web/server.ts` wird durch einen normalen Node-Server wie hier ersetzt,
und `AWS::Lambda::Function` + `AWS::Lambda::Url` + `AWS::Lambda::Permission` werden zu den drei
`WebFunction*`-Ressourcen + `ResourcePolicy` + OAC.

### Eine Stelle braucht trotzdem etwas Klebstoff: der Host

CloudFront schickt der Origin deren eigenen Hostnamen als `Host`. React Router baut `request.url`
aus dem Host und lehnt Actions (POST) ab, deren `Origin` nicht passt. Die viewer-request function
schreibt deshalb den Viewer-Host in `x-viewer-host` und überschreibt dabei jeden Wert, den ein
Client mitschickt. `server.ts` setzt daraus `Host`, `X-Forwarded-Host` und `X-Forwarded-Proto`.
Ohne diese Stelle funktionieren GET-Requests, aber jeder Form-Submit liefert 400.

## Lokal

```sh
npm ci
npm run dev        # Vite-Dev-Server mit HMR
npm run build      # react-router build + esbuild → dist/ (= Deployment-Paket)
npm start          # startet dist/index.js auf 127.0.0.1:3000 (oder AWS_LAMBDA_HTTP_ENDPOINT)
npm run smoke      # startet dist/index.js wie Lambda und testet GET, Assets, POST, CSRF
npm run check      # format:check + typecheck + build + smoke
```

`dist/` enthält nur `index.js` (Server + React-Router-Build, gebündelt), `package.json`
(`"type": "module"`) und `client/`. `node_modules` werden nicht mitgeliefert.

## Deployment

Der Workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) läuft so:

1. **Check & build** (jeder Push/PR): cfn-lint, `npm run check`, `dist/` zippen und als Artifact
   hochladen.
2. **Deploy** (nur `main`, auch manuell per `workflow_dispatch`):
   - `web.zip` nach `s3://react-router-web-function-artifacts-<account-id>/versions/<sha>/`
     hochladen. Der Bucket wird bei Bedarf angelegt.
   - Stack `react-router-web-function` in **eu-west-1** deployen.
   - Smoke-Test gegen die CloudFront-URL: SSR, Assets, POST, CSRF.
   - Prüfen, dass ein direkter Aufruf des Web-Function-Endpoints **403** liefert.

Die CloudFront-URL steht in der Job-Summary und in den Stack-Outputs (`DistributionUrl`).

### Einrichtung

- Repository-Variable `AWS_ACCESS_KEY_ID` und Secret `AWS_SECRET_ACCESS_KEY`, wie bei Fetchbot.
- Der IAM-User braucht Rechte für CloudFormation, `lambda:*WebFunction*` sowie
  `lambda:PutResourcePolicy`, `GetResourcePolicy` und `DeleteResourcePolicy`, außerdem
  `iam:CreateRole`/`PassRole`, CloudFront, CloudWatch Logs, S3 und `sts:GetCallerIdentity`.

### Region

Web Functions gibt es bisher nur in us-east-1, us-east-2, us-west-2, ap-northeast-1 und
**eu-west-1**. Fetchbots eu-central-1 ist nicht dabei, deshalb verwendet der Workflow eu-west-1.
Geändert wird das über `AWS_REGION` im Workflow.

## Noch nicht gegen AWS verifiziert

Der lokale Smoke-Test simuliert CloudFront, indem er `x-viewer-host` selbst setzt. Erst der
Deploy-Job zeigt, ob die Kette mit echter OAC funktioniert. Darauf kommt es an:

- CloudFront leitet `x-viewer-host` und `Origin` über `AllViewerExceptHostHeader` an die Web
  Function weiter, und Lambda reicht sie unverändert an den Server durch.
- POST-Bodies gehen mit `always-amz-auth` ohne `x-amz-content-sha256` durch. Laut AWS-Doku ist
  das bei Web Functions so, anders als bei Function URLs.
- Die Resource Policy mit `Resource: <EndpointArn>` und `Action: lambda:InvokeWebFunctionEndpoint`
  reicht aus.
