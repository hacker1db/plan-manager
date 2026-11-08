import { apiError, forbidden, publicPlan } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { isSameOriginRequest } from '@/hosted/lib/security'
import { updatePlanStatus } from '@/hosted/lib/store'
import { isPlanStatus } from '@/lib/types'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try {
    const input: unknown = await request.json()
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('status' in input) || !isPlanStatus(input.status)) return Response.json({ error: 'Invalid plan status' }, { status: 400 })
    const result = await updatePlanStatus(params.id, input.status)
    if (!result.plan) return Response.json({ error: 'Not found' }, { status: 404 })
    if (result.conflict) return Response.json({ error: 'Plan changed concurrently', currentRevision: result.plan.revision }, { status: 409 })
    return Response.json({ ...publicPlan(result.plan), url: `/plans/${encodeURIComponent(result.plan.id)}`, isArchived: result.plan.status === 'archived' }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiError(error) }
}
