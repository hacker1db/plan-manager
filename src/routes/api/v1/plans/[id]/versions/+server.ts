import { apiError, forbidden, publicPlan } from '@/hosted/lib/api'
import { requireWriteToken } from '@/hosted/lib/auth'
import { requirePlanId } from '@/hosted/lib/sanitize'
import { writePlan } from '@/hosted/lib/store'
import type { HostedPlanInput } from '@/hosted/lib/types'
import type { RequestHandler } from './$types'

export const PUT: RequestHandler = async ({ params, request }) => {
  const denied = await requireWriteToken(request, 'plans:write')
  if (denied) return denied
  try {
    const id = requirePlanId(params.id)
    const body = await request.json() as HostedPlanInput
    if (body.id !== id) return forbidden()
    const result = await writePlan(body)
    if (result.conflict) return Response.json({ error: 'Revision conflict', currentRevision: result.plan?.revision ?? null }, { status: 409 })
    return Response.json({ version: 1, plan: publicPlan(result.plan), url: `/plans/${result.plan.id}` }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiError(error) }
}
