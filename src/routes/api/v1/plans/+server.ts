import { apiError, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "#lib/server/api.ts"
import { requireOwnerResponse } from "#lib/server/auth.ts"
import { searchPlans } from "#lib/server/plan-search.ts"
import { listPlans, readMarkdown } from "#lib/server/store.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ url, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const matches = await searchPlans(await listPlans(), url, readMarkdown)
    return jsonResponse({ version: 1, plans: matches.map(publicPlan) }, { headers: PRIVATE_NO_STORE })
  } catch (error) { return apiError(error) }
}
