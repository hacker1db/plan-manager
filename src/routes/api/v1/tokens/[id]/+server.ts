import { apiError, forbidden, jsonResponse } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { isSameOriginRequest } from "$lib/server/security.ts"
import { revokeToken } from "$lib/server/store.ts"
import type { RequestHandler } from "./$types"

export const DELETE: RequestHandler = async ({ request, params, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try { return jsonResponse({ revoked: await revokeToken(params.id) }) } catch (error) { return apiError(error) }
}
