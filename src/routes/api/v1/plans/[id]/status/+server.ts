import { apiError, forbidden, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { isJsonRequest, isSameOriginRequest } from "$lib/server/security.ts"
import { changeMobileStatus, statusInput } from "$lib/server/mobile.ts"
import { findPlan, readMarkdown, writePlan } from "$lib/server/store.ts"
import { createStatusVersion } from "$lib/server/status-version.ts"
import type { RequestHandler } from "./$types"

export const POST: RequestHandler = async ({ request, params, locals }) => {
  if (request.headers.has("authorization") && request.headers.has("cookie")) return forbidden()
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  // A bearer must authenticate as a session through Clerk. Cookie requests retain CSRF protection.
  if (!request.headers.get("authorization")?.startsWith("Bearer ") && !isSameOriginRequest(request)) return forbidden()
  if (!isJsonRequest(request)) return jsonResponse({error: "Expected application/json"}, {status: 415, headers: PRIVATE_NO_STORE})
  try {
    const input = statusInput(await request.json())
    if (!input) return jsonResponse({error: "Expected status and expectedRevision"}, {status: 400, headers: PRIVATE_NO_STORE})
    const result = await changeMobileStatus(params.id, input, {find: findPlan, read: readMarkdown, write: writePlan, version: createStatusVersion})
    return jsonResponse(result.plan ? publicPlan(result.plan) : {error: result.error, currentRevision: result.currentRevision}, {status: result.status, headers: PRIVATE_NO_STORE})
  } catch (error) { return apiError(error) }
}
