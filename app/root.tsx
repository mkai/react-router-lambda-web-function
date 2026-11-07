import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from 'react-router'
import type { Route } from './+types/root'

export const meta: Route.MetaFunction = () => [{ title: 'React Router on Lambda Web Functions' }]

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: 'system-ui, sans-serif', lineHeight: 1.5, margin: '2rem' }}>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error'

  return (
    <main>
      <h1>Oops</h1>
      <pre>{message}</pre>
    </main>
  )
}
