import { apiError, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { searchPlans } from "$lib/server/plan-search.ts"
import { listPlans, readMarkdown } from "$lib/server/store.ts"
import { pagePlans } from "$lib/server/mobile.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ url, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const matches = await searchPlans(await listPlans(), url, readMarkdown)
    const page = pagePlans(matches, url)
    return jsonResponse({ version: 1, ...page, plans: page.plans.map(publicPlan) }, { headers: PRIVATE_NO_STORE })
  } catch (error) {
    if (error instanceof RangeError) return jsonResponse({error: error.message}, {status: 400, headers: PRIVATE_NO_STORE})
    return apiError(error)
  }
}
