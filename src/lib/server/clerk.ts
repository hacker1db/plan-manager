import { createClerkClient, type ClerkClient } from "@clerk/backend"
import { AuthStatus, createClerkRequest, createRedirect, getAuthObjectForAcceptedToken } from "@clerk/backend/internal"
import { environmentSource, getClerkSignInUrl } from "./env.ts"
import type { AcceptedToken, AuthReader, RequestAuth } from "./auth.ts"

// Framework-independent replacement for @clerk/nextjs `clerkMiddleware()` + `auth()`.
// It uses the same Clerk instance and the same environment variables; nothing in the
// Clerk dashboard changes. Every request is authenticated once with `acceptsToken: "any"`
// (as clerkMiddleware did) and route code narrows to the token type it accepts.

export type ClerkRequestState = {
  status: "signed-in" | "signed-out" | "handshake"
  headers: Headers
  auth: AuthReader
  redirectToSignIn: () => Response
}

export type Authenticator = (request: Request) => Promise<ClerkRequestState>

export const signedOut: AuthReader = () => ({ isAuthenticated: false, userId: null, clientId: null, scopes: null })

function toRequestAuth(value: unknown): RequestAuth {
  const auth = (value ?? {}) as { isAuthenticated?: unknown; userId?: unknown; clientId?: unknown; scopes?: unknown }
  return {
    isAuthenticated: auth.isAuthenticated === true,
    userId: typeof auth.userId === "string" ? auth.userId : null,
    clientId: typeof auth.clientId === "string" ? auth.clientId : null,
    scopes: Array.isArray(auth.scopes) ? auth.scopes.filter((scope): scope is string => typeof scope === "string") : null,
  }
}

function temporaryRedirect(location: string, headers?: Headers): Response {
  const response = new Response(null, { status: 307, headers })
  response.headers.set("Location", location)
  return response
}

export function createClerkAuthenticator(source = environmentSource): Authenticator {
  let client: ClerkClient | undefined
  let clientKey = ""
  return async request => {
    const env = source()
    const secretKey = env.CLERK_SECRET_KEY?.trim() ?? ""
    const publishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? ""
    const signInUrl = getClerkSignInUrl(env)
    if (!client || clientKey !== `${publishableKey}:${secretKey}`) {
      client = createClerkClient({ secretKey, publishableKey })
      clientKey = `${publishableKey}:${secretKey}`
    }
    const clerkRequest = createClerkRequest(request)
    const state = await client.authenticateRequest(clerkRequest, {
      acceptsToken: "any",
      secretKey,
      publishableKey,
      signInUrl,
      // Session tokens must have been minted for this origin (CSRF / subdomain cookie leak guard).
      authorizedParties: [clerkRequest.clerkUrl.origin],
    })
    const authObject = state.status === AuthStatus.Handshake ? null : state.toAuth()
    const reader: AuthReader = (acceptsToken: AcceptedToken = "session_token") => authObject
      ? toRequestAuth(getAuthObjectForAcceptedToken({ authObject, acceptsToken }))
      : signedOut()
    return {
      status: state.status,
      headers: state.headers,
      auth: reader,
      redirectToSignIn: () => createRedirect({
        redirectAdapter: (url: string | URL) => temporaryRedirect(String(url)),
        baseUrl: clerkRequest.clerkUrl,
        signInUrl,
        publishableKey,
        sessionStatus: authObject && "sessionStatus" in authObject ? authObject.sessionStatus as never : undefined,
        devBrowserToken: clerkRequest.cookies.get("__clerk_db_jwt"),
      }).redirectToSignIn({ returnBackUrl: clerkRequest.clerkUrl.toString() }),
    }
  }
}

export function handshakeResponse(state: ClerkRequestState): Response {
  const location = state.headers.get("location")
  if (!location) throw new Error("Clerk: handshake status without redirect")
  return temporaryRedirect(location, state.headers)
}
