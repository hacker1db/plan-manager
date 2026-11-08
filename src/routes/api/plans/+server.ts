import { createHash } from "node:crypto"
import { apiError, jsonResponse, PRIVATE_NO_STORE, publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { searchPlans } from "$lib/server/plan-search.ts"
import { listPlans, readMarkdown } from "$lib/server/store.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ url, locals }) => {
  const denied = await requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plans = await listPlans()
    const matches = await searchPlans(plans, url, readMarkdown)
    const fingerprint = createHash("sha256").update(plans.map(plan => `${plan.id}:${plan.revision}`).join("\n")).digest("hex")
    return jsonResponse({
      plans: matches.map(plan => ({ ...publicPlan(plan), url: `/plans/${encodeURIComponent(plan.id)}`, isArchived: plan.status === "archived" })),
      malformed: [],
      fingerprint,
    }, { headers: PRIVATE_NO_STORE })
  } catch (error) { return apiError(error) }
}
