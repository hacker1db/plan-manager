import type { Handle } from "@sveltejs/kit"
import { environmentSource, getOwnerClerkUserIds, isAllowedOwner } from "./env.ts"
import { handshakeResponse, signedOut, type Authenticator } from "./clerk.ts"

// Port of src/proxy.ts (Next.js middleware). Every page and API request except Clerk
// sign-in and the CLI `/api/v1` surface must come from an allowlisted Clerk owner;
// `/api/v1` routes perform their own owner/token checks. Static assets never reach hooks.

export function bypassesOwnerGate(pathname: string): boolean {
  return pathname.startsWith("/sign-in") || pathname === "/api/v1" || pathname.startsWith("/api/v1/")
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } })
}

export function createHandle(authenticate: Authenticator, source = environmentSource): Handle {
  return async ({ event, resolve }) => {
    const env = source()
    const bypass = bypassesOwnerGate(event.url.pathname)
    const clerkConfigured = Boolean(env.CLERK_SECRET_KEY?.trim() && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim())
    event.locals.auth = signedOut
    // Fail closed. `/api/v1` routes answer 503 themselves via HostedConfigurationError.
    if (!clerkConfigured) return bypass ? resolve(event) : text("Hosted service is unavailable", 503)
    if (!bypass && getOwnerClerkUserIds(env).length === 0) return text("Hosted service is unavailable", 503)
    const state = await authenticate(event.request)
    if (state.status === "handshake") return handshakeResponse(state)
    event.locals.auth = state.auth
    if (!bypass) {
      const { userId } = state.auth("session_token")
      if (!userId) return state.redirectToSignIn()
      if (!isAllowedOwner(userId, env)) return text("Forbidden", 403)
    }
    const response = await resolve(event)
    // clerkMiddleware forwarded request-state cookies (e.g. dev-browser sync) on responses.
    const cookies = state.headers.getSetCookie?.() ?? []
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie)
    return response
  }
}
