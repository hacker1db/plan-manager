import { error } from "@sveltejs/kit"
import { publicPlan } from "$lib/server/api.ts"
import { requireOwnerResponse } from "$lib/server/auth.ts"
import { renderPlanHtml } from "$lib/server/plan-markdown.tsx"
import { findPlan, readMarkdown } from "$lib/server/store.ts"
import type { PageServerLoad } from "./$types"

const PLAN_ID = /^[A-Za-z0-9_-]{8,128}$/

export const load: PageServerLoad = async ({ params, locals, setHeaders }) => {
  if (await requireOwnerResponse(locals.auth)) error(404, "Not found")
  if (!PLAN_ID.test(params.id)) error(404, "Not found")
  const plan = await findPlan(params.id)
  if (!plan) error(404, "Not found")
  const markdown = await readMarkdown(plan)
  setHeaders({ "Cache-Control": "private, no-store" })
  return { plan: publicPlan(plan), markdown, html: renderPlanHtml(markdown) }
}
