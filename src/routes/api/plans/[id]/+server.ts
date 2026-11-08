import { apiError, jsonResponse, notFound, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { findPlan, readMarkdown } from "$lib/server/store.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ params, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return notFound()
    return jsonResponse({
      ...publicPlan(plan),
      markdown: await readMarkdown(plan),
      url: `/plans/${encodeURIComponent(plan.id)}`,
      isArchived: plan.status === "archived",
    }, { headers: PRIVATE_NO_STORE })
  } catch (error) { return apiError(error) }
}
