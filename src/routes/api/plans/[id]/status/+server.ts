import { apiError, forbidden, jsonResponse, notFound, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { isSameOriginRequest } from "$lib/server/security.ts"
import { updatePlanStatus } from "$lib/server/store.ts"
import { isPlanStatus } from "$lib/types.ts"
import type { RequestHandler } from "./$types"

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try {
    const input: unknown = await request.json()
    if (!input || typeof input !== "object" || Array.isArray(input) || !("status" in input) || !isPlanStatus(input.status)) {
      return jsonResponse({ error: "Invalid plan status" }, { status: 400 })
    }
    const result = await updatePlanStatus(params.id, input.status)
    if (!result.plan) return notFound()
    if (result.conflict) return jsonResponse({ error: "Plan changed concurrently", currentRevision: result.plan.revision }, { status: 409 })
    return jsonResponse({ ...publicPlan(result.plan), url: `/plans/${encodeURIComponent(result.plan.id)}`, isArchived: result.plan.status === "archived" }, { headers: PRIVATE_NO_STORE })
  } catch (error) { return apiError(error) }
}
