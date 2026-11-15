import { authKitHandle, configureAuthKit } from '@workos/authkit-sveltekit'
import type { Handle } from '@sveltejs/kit/hooks'
import * as env from '$app/env/private'
import { setEnvironmentSource, getHostedEnvironment, HostedConfigurationError, isAllowedOwner } from '#lib/server/env.ts'
import { apiAccessDenial, isApiPath } from '#lib/server/api-access.ts'
import { withSecurityHeaders } from '#lib/server/headers.ts'

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
  // Logged once at module load. HostedConfigurationError carries variable names only, never values.
  console.error(`Hosted Plan Manager is not configured; every dynamic route returns 503. Missing or invalid: ${error.missing.join(', ')}`)
}

// Hardening headers (and a fallback CSP for non-page responses) on every response; pages get
// their nonce-based CSP from SvelteKit's `csp` option in vite.config.ts.
export const handle: Handle = async input => withSecurityHeaders(await route(input))

const route: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname
  // Public CLI discovery answers even when WorkOS is unconfigured (it reports its own 503).
  if ((event.request.method === 'GET' && path === '/api/v1') || publicAssets.has(path)) return resolve(event)
  if (!workosHandle) return new Response('Hosted service is unavailable', { status: 503 })

  return workosHandle({
    event,
    resolve: async authenticatedEvent => {
      if (authRoutes.has(path)) return resolve(authenticatedEvent)
      if (isApiPath(path)) {
        // Deny by default: only the exact allow-list in api-access.ts skips the owner session check.
        // Handlers still run their own requireOwnerResponse/requireWriteToken guards.
        return apiAccessDenial(event.request.method, path, authenticatedEvent.locals.auth.user) ?? resolve(authenticatedEvent)
      }
      if (!authenticatedEvent.locals.auth.user) return new Response(null, { status: 303, headers: { location: '/sign-in' } })
      if (!isAllowedOwner(authenticatedEvent.locals.auth.user.id)) return new Response('Forbidden', { status: 403 })
      return resolve(authenticatedEvent)
    },
  })
}
