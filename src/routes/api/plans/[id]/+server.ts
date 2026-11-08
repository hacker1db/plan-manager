import { apiError, publicPlan } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { findPlan, readMarkdown } from '@/hosted/lib/store'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals, params }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    if (!plan) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ ...publicPlan(plan), markdown: await readMarkdown(plan), url: `/plans/${encodeURIComponent(plan.id)}`, isArchived: plan.status === 'archived' }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiError(error) }
}
