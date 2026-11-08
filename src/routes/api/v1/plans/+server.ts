import { apiError, publicPlan } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { listPlans, readMarkdown } from '@/hosted/lib/store'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals, url }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  try {
    const plans = await listPlans()
    const query = url.searchParams.get('q')?.trim().toLowerCase().slice(0, 256)
    const matches = !query ? plans : (await Promise.all(plans.map(async plan => `${plan.title} ${plan.tags.join(' ')} ${await readMarkdown(plan)}`.toLowerCase().includes(query) ? plan : null))).filter(plan => plan !== null)
    return Response.json({ version: 1, plans: matches.map(publicPlan) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return apiError(error) }
}
