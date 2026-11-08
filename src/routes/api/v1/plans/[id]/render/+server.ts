import { apiError, jsonResponse, notFound, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { findPlan, readMarkdown } from "$lib/server/store.ts"
import { renderPlanHtml } from "$lib/server/plan-markdown.tsx"
import { statusAvailability } from "$lib/server/mobile.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ params, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return notFound()
    const markdown = await readMarkdown(plan)
    return jsonResponse({version: 1, plan: publicPlan(plan), html: renderPlanHtml(markdown), statusUnavailableReason: statusAvailability(markdown)}, {headers: PRIVATE_NO_STORE})
  } catch (error) { return apiError(error) }
}
