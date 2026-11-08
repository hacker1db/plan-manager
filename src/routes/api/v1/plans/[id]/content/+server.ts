import { apiError } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { findPlan, readMarkdown } from '@/hosted/lib/store'
import { extensionFor, sourceFormat } from '@/lib/mdx/format'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals, params }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return Response.json({ error: 'Not found' }, { status: 404 })
    const markdown = await readMarkdown(plan)
    return new Response(markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${plan.id}${extensionFor(sourceFormat(markdown))}"`, 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiError(error) }
}
