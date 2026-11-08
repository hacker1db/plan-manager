import { error } from '@sveltejs/kit'
import { hostedPlanShell } from '@/hosted/lib/dashboard'
import { publicPlan } from '@/hosted/lib/api'
import { findPlan, readMarkdown } from '@/hosted/lib/store'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ params }) => {
  const plan = await findPlan(params.id)
  if (!plan) throw error(404, 'Plan not found')
  const markdown = await readMarkdown(plan)
  return { shell: hostedPlanShell(publicPlan(plan), markdown), title: plan.title }
}
