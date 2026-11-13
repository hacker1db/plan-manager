import type { AuthKitAuth } from "@workos/authkit-sveltekit"
import { getHostedEnvironment, HostedConfigurationError } from "./env"
import { forbidden, unauthorized } from "./api"
import { findToken } from "./store"
import { parseBearer, tokenAuthorizes } from "./token"
import type { PlanScope } from "../hosted/types.ts"
import { verifyWorkosCliToken } from "./workos-cli"
import { verifyWorkosNativeToken } from "./workos-native"

export { verifyWorkosCliToken } from "./workos-cli"

function bearerValue(value: string | null): string | null {
  const match = value?.match(/^Bearer ([^\s]+)$/)
  return match?.[1] ?? null
}

export function ownerId(auth: AuthKitAuth): string | null {
  return auth.user?.id ?? null
}

export function requireOwnerResponse(auth: AuthKitAuth): Response | null {
  try {
    const userId = ownerId(auth)
    if (!userId) return unauthorized()
    return getHostedEnvironment().ownerWorkosUserIds.includes(userId) ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return Response.json({ error: "Hosted service is unavailable" }, { status: 503 })
    throw error
  }
}

export type OwnerAccess = { denied: Response; bearer?: never } | { denied: null; bearer: boolean }

/**
 * Owner read/write gate for the v1 API. A request carrying Authorization must present a native
 * WorkOS access token; the browser cookie session is only consulted when no Authorization header
 * is sent, so a bad bearer never silently falls back to ambient cookies. `bearer` lets callers skip
 * CSRF origin checks that only matter for cookie-authenticated requests.
 */
export async function requireOwnerRequest(request: Request, auth: AuthKitAuth): Promise<OwnerAccess> {
  const authorization = request.headers.get("authorization")
  if (authorization === null) {
    const denied = requireOwnerResponse(auth)
    return denied ? { denied } : { denied: null, bearer: false }
  }
  const bearer = bearerValue(authorization)
  // pm_ upload tokens and malformed headers never grant owner reads.
  if (!bearer || bearer.startsWith("pm_")) return { denied: unauthorized() }
  try {
    return await verifyWorkosNativeToken(bearer) ? { denied: null, bearer: true } : { denied: forbidden() }
  } catch (error) {
    if (error instanceof HostedConfigurationError) return { denied: Response.json({ error: "Native sign-in is not configured" }, { status: 503 }) }
    return { denied: unauthorized() }
  }
}

export async function requireWriteToken(request: Request, scope: PlanScope): Promise<Response | null> {
  const authorization = request.headers.get("authorization")
  const bearer = bearerValue(authorization)
  if (!bearer) return unauthorized()

  if (!bearer.startsWith("pm_")) {
    if (scope !== "plans:write") return forbidden()
    try {
      return await verifyWorkosCliToken(bearer) ? null : forbidden()
    } catch (error) {
      if (error instanceof HostedConfigurationError) return Response.json({ error: "Hosted service is unavailable" }, { status: 503 })
      return unauthorized()
    }
  }

  const parsed = parseBearer(authorization)
  if (!parsed) return unauthorized()
  try {
    const record = await findToken(parsed.id)
    return await tokenAuthorizes(record, parsed.secret, getHostedEnvironment().tokenPepper, scope) ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return Response.json({ error: "Hosted service is unavailable" }, { status: 503 })
    throw error
  }
}
