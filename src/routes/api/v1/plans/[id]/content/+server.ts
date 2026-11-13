import { apiError, notFound } from "#lib/server/api.ts"
import { requireOwnerRequest } from "#lib/server/auth.ts"
import { findPlan, readMarkdown } from "#lib/server/store.ts"
import { extensionFor, sourceFormat } from "#lib/mdx/format.ts"
import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ request, params, locals }) => {
  const { denied } = await requireOwnerRequest(request, locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return notFound()
    const markdown = await readMarkdown(plan)
    const extension = extensionFor(sourceFormat(markdown))
    return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${plan.id}${extension}"`, "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
