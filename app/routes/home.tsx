import { useState } from 'react'
import { Form } from 'react-router'
import type { Route } from './+types/home'

// Module scope lives as long as the execution environment. A Web Function
// environment serves many (also concurrent) requests, so these values show
// whether a request hit a warm or a fresh environment.
const environmentStartedAt = new Date().toISOString()
let requestsServedByThisEnvironment = 0

export function headers() {
  return { 'cache-control': 'private, no-store' }
}

export function loader({ request }: Route.LoaderArgs) {
  requestsServedByThisEnvironment += 1

  return {
    renderedAt: new Date().toISOString(),
    environmentStartedAt,
    requestsServedByThisEnvironment,
    nodeVersion: process.version,
    arch: process.arch,
    region: process.env['AWS_REGION'] ?? 'local',
    requestUrl: request.url,
  }
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const name = formData.get('name')
  return {
    greeting: `Hello ${typeof name === 'string' && name.trim() ? name.trim() : 'stranger'}!`,
    method: request.method,
  }
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const [clicks, setClicks] = useState(0)

  return (
    <main>
      <h1>React Router on AWS Lambda Web Functions</h1>

      <h2>Server-side rendered</h2>
      <dl>
        <dt>Rendered at</dt>
        <dd data-testid="rendered-at">{loaderData.renderedAt}</dd>
        <dt>Execution environment started at</dt>
        <dd>{loaderData.environmentStartedAt}</dd>
        <dt>Requests served by this environment</dt>
        <dd>{loaderData.requestsServedByThisEnvironment}</dd>
        <dt>Runtime</dt>
        <dd data-testid="runtime">
          Node.js {loaderData.nodeVersion} on {loaderData.arch} in {loaderData.region}
        </dd>
        <dt>Request URL as seen by the server</dt>
        <dd data-testid="request-url">{loaderData.requestUrl}</dd>
      </dl>

      <h2>Action (POST)</h2>
      <Form method="post">
        <input name="name" placeholder="Your name" aria-label="Your name" />{' '}
        <button type="submit">Send</button>
      </Form>
      {actionData ? (
        <p data-testid="greeting">
          {actionData.greeting} (handled via {actionData.method})
        </p>
      ) : null}

      <h2>Hydration</h2>
      <button type="button" onClick={() => setClicks((count) => count + 1)}>
        Clicked {clicks} times
      </button>
    </main>
  )
}
