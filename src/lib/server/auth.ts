import { getHostedEnvironment, HostedConfigurationError, oauthTokenCanAccess } from "./env.ts"
import { forbidden, unauthorized, unavailable } from "./api.ts"
import { parseBearer, tokenAuthorizes } from "./token.ts"
import type { PlanScope, TokenRecord } from "../hosted/types.ts"

export type AcceptedToken = "session_token" | "oauth_token"

// The subset of Clerk's auth object that authorization decisions read. Session auth has
// no clientId/scopes; OAuth access tokens carry the issuing OAuth application and scopes.
export type RequestAuth = {
  isAuthenticated: boolean
  userId: string | null
  clientId?: string | null
  scopes?: readonly string[] | null
}

// Installed on event.locals by the Clerk hook; equivalent to Next's `auth({ acceptsToken })`.
export type AuthReader = (acceptsToken?: AcceptedToken) => RequestAuth

export type TokenLookup = (id: string) => Promise<TokenRecord | null>

async function lookupStoredToken(id: string): Promise<TokenRecord | null> {
  const { findToken } = await import("./store.ts")
  return findToken(id)
}

// Browser/session owner check used by every owner API and page load.
export async function requireOwnerResponse(auth: AuthReader): Promise<Response | null> {
  try {
    const { ownerClerkUserIds } = getHostedEnvironment()
    const { userId } = auth("session_token")
    if (!userId) return unauthorized()
    return ownerClerkUserIds.includes(userId) ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return unavailable()
    throw error
  }
}

// CLI write authorization: `Bearer pm_<id>_<secret>` Plan Manager tokens, or a Clerk OAuth
// access token issued to PLAN_MANAGER_OAUTH_CLIENT_ID for an allowlisted owner.
export async function requireWriteToken(request: Request, scope: PlanScope, auth: AuthReader, lookup: TokenLookup = lookupStoredToken): Promise<Response | null> {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return unauthorized()
  if (!authorization.startsWith("Bearer pm_")) {
    try {
      const authState = auth("oauth_token")
      if (!authState.isAuthenticated || !authState.userId) return unauthorized()
      if (!oauthTokenCanAccess(authState.userId, authState.clientId ?? null, authState.scopes ?? [])) return forbidden()
      return null
    } catch (error) {
      if (error instanceof HostedConfigurationError) return unavailable()
      throw error
    }
  }
  const parsed = parseBearer(authorization)
  if (!parsed) return unauthorized()
  try {
    const { tokenPepper } = getHostedEnvironment()
    const record = await lookup(parsed.id)
    return await tokenAuthorizes(record, parsed.secret, tokenPepper, scope) ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return unavailable()
    throw error
  }
}
