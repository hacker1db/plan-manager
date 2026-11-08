import { apiError, publicPlan } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { findPlan } from '@/hosted/lib/store'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals, params }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plan = await findPlan(params.id)
    return plan ? Response.json(publicPlan(plan), { headers: { 'Cache-Control': 'private, no-store' } }) : Response.json({ error: 'Not found' }, { status: 404 })
  } catch (error) { return apiError(error) }
}
