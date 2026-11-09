import { authKitHandle, configureAuthKit } from '@workos/authkit-sveltekit'
import type { Handle } from '@sveltejs/kit/hooks'
import * as env from '$app/env/private'
import { setEnvironmentSource, getHostedEnvironment, HostedConfigurationError, isAllowedOwner } from '#lib/server/env.ts'

setEnvironmentSource(env)

const publicAssets = new Set(['/app.js', '/plan.js', '/dashboard-icon.png', '/globals.css'])
const authRoutes = new Set(['/sign-in', '/callback', '/sign-out', '/auth/error'])
let workosHandle: Handle | null = null

try {
  const environment = getHostedEnvironment()
  configureAuthKit({
    clientId: environment.workosClientId,
    apiKey: environment.workosApiKey,
    redirectUri: environment.workosRedirectUri,
    cookiePassword: environment.workosCookiePassword,
  })
  workosHandle = authKitHandle()
} catch (error) {
  if (!(error instanceof HostedConfigurationError)) throw error
}

// Anti-framing and hardening headers applied to every response. script-src is intentionally
// left unrestricted so /app.js, /plan.js and SvelteKit's inline hydration keep working.
export const securityHeaders: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https://api.workos.com",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

function withSecurityHeaders(response: Response): Response {
  try {
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value)
    return response
  } catch {
    // Immutable headers (e.g. Response.redirect or fetch results): copy into a mutable response.
    const copy = new Response(response.body, response)
    for (const [name, value] of Object.entries(securityHeaders)) copy.headers.set(name, value)
    return copy
  }
}

export const handle: Handle = async input => withSecurityHeaders(await route(input))

const route: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname
  if (path === '/api/v1' || publicAssets.has(path)) return resolve(event)
  if (!workosHandle) return new Response('Hosted service is unavailable', { status: 503 })

  return workosHandle({
    event,
    resolve: async authenticatedEvent => {
      const apiRoute = path === '/api' || path.startsWith('/api/')
      if (authRoutes.has(path) || apiRoute) return resolve(authenticatedEvent)
      if (!authenticatedEvent.locals.auth.user) return new Response(null, { status: 303, headers: { location: '/sign-in' } })
      if (!isAllowedOwner(authenticatedEvent.locals.auth.user.id)) return new Response('Forbidden', { status: 403 })
      return resolve(authenticatedEvent)
    },
  })
}
