import { apiError, forbidden, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "#lib/server/api.ts"
import { requireWriteToken } from "#lib/server/auth.ts"
import { requirePlanId } from "#lib/server/sanitize.ts"
import { writePlan } from "#lib/server/store.ts"
import type { HostedPlanInput } from "#lib/hosted/types.ts"
import type { RequestHandler } from "./$types"

// CLI upload (`plan push`): pm_ tokens with plans:write, or Clerk OAuth tokens for the CLI app.
export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const denied = await requireWriteToken(request, "plans:write", locals.auth)
  if (denied) return denied
  try {
    const id = requirePlanId(params.id)
    const body = await request.json() as HostedPlanInput
    if (body.id !== id) return forbidden()
    const result = await writePlan(body)
    if (result.conflict) return jsonResponse({ error: "Revision conflict", currentRevision: result.plan?.revision ?? null }, { status: 409 })
    return jsonResponse({ version: 1, plan: publicPlan(result.plan), url: `/plans/${result.plan.id}` }, { status: 201, headers: PRIVATE_NO_STORE })
  } catch (error) { return apiError(error) }
}
