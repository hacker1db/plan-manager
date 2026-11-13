import { apiError, jsonResponse, notFound, PRIVATE_NO_STORE, publicPlan } from "#lib/server/api.ts"
import { requireOwnerRequest } from "#lib/server/auth.ts"
import { findPlan, readMarkdown } from "#lib/server/store.ts"
import { mobileDocument } from "#lib/server/mobile-document.ts"
import { statusAvailability } from "#lib/server/mobile.ts"
import type { PlanRenderResponse } from "#lib/hosted/types.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ request, params, locals }) => {
  const { denied } = await requireOwnerRequest(request, locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return notFound()
    const markdown = await readMarkdown(plan)
    const body = {version: 1, plan: publicPlan(plan), ...mobileDocument(markdown), statusUnavailableReason: statusAvailability(markdown)} satisfies PlanRenderResponse
    return jsonResponse(body, {headers: PRIVATE_NO_STORE})
  } catch (error) { return apiError(error) }
}
