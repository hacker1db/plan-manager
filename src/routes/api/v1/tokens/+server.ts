import { apiError, forbidden, jsonResponse } from "#lib/server/api.ts"
import { requireOwnerResponse } from "#lib/server/auth.ts"
import { getHostedEnvironment } from "#lib/server/env.ts"
import { isJsonRequest, isSameOriginRequest } from "#lib/server/security.ts"
import { createToken } from "#lib/server/store.ts"
import { generateToken, hashSecret, parseTokenRequest } from "#lib/server/token.ts"
import type { RequestHandler } from "./$types"

export const POST: RequestHandler = async ({ request, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  if (!isJsonRequest(request)) return jsonResponse({ error: "Expected JSON" }, { status: 415 })
  try {
    const { scopes, expiresAt } = parseTokenRequest(await request.json())
    const generated = generateToken()
    const token = await createToken({ id: generated.id, scopes, expiresAt, revokedAt: null, secretHash: await hashSecret(generated.secret, getHostedEnvironment().tokenPepper) })
    return jsonResponse({ version: 1, token, bearer: generated.bearer }, { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
