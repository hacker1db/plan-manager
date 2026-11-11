import type { AuthKitAuth } from "@workos/authkit-sveltekit"
import { getHostedEnvironment, HostedConfigurationError } from "./env"
import { forbidden, unauthorized } from "./api"
import { findToken, touchToken } from "./store"
import { parseBearer, tokenAuthorizes } from "./token"
import type { PlanScope } from "../hosted/types.ts"
import { verifyWorkosCliToken } from "./workos-cli"

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
    if (!await tokenAuthorizes(record, parsed.secret, getHostedEnvironment().tokenPepper, scope)) return forbidden()
    // Best effort: a failed last-used update (e.g. migration 002 not yet applied) must not fail the request.
    await touchToken(parsed.id).catch(() => undefined)
    return null
  } catch (error) {
    if (error instanceof HostedConfigurationError) return Response.json({ error: "Hosted service is unavailable" }, { status: 503 })
    throw error
  }
}
