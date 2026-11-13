import { apiError, forbidden, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "#lib/server/api.ts"
import { requireOwnerRequest } from "#lib/server/auth.ts"
import { isJsonRequest, isSameOriginRequest } from "#lib/server/security.ts"
import { changeMobileStatus, statusInput } from "#lib/server/mobile.ts"
import { findPlan, readMarkdown, writePlan } from "#lib/server/store.ts"
import { createStatusVersion } from "#lib/server/status-version.ts"
import type { RequestHandler } from "./$types"

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const access = await requireOwnerRequest(request, locals.auth)
  if (access.denied) return access.denied
  // Cookie sessions are ambient, so they keep the exact-origin CSRF check. A verified native
  // bearer token is never attached automatically by a browser, so it needs no origin check.
  if (!access.bearer && !isSameOriginRequest(request)) return forbidden()
  if (!isJsonRequest(request)) return jsonResponse({error: "Expected application/json"}, {status: 415, headers: PRIVATE_NO_STORE})
  try {
    const input = statusInput(await request.json())
    if (!input) return jsonResponse({error: "Expected status and expectedRevision"}, {status: 400, headers: PRIVATE_NO_STORE})
    const result = await changeMobileStatus(params.id, input, {find: findPlan, read: readMarkdown, write: writePlan, version: createStatusVersion})
    return jsonResponse(result.plan ? publicPlan(result.plan) : {error: result.error, currentRevision: result.currentRevision}, {status: result.status, headers: PRIVATE_NO_STORE})
  } catch (error) { return apiError(error) }
}
