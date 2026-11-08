import type { HostedPlan } from "../hosted/types.ts"

// Shared by /api/plans and /api/v1/plans: case-insensitive match on title, tags, and Markdown.
export async function searchPlans(plans: HostedPlan[], url: URL, readMarkdown: (plan: HostedPlan) => Promise<string>): Promise<HostedPlan[]> {
  const query = url.searchParams.get("q")?.trim().toLowerCase().slice(0, 256)
  if (!query) return plans
  const matches = await Promise.all(plans.map(async plan => {
    const text = `${plan.title} ${plan.tags.join(" ")} ${await readMarkdown(plan)}`.toLowerCase()
    return text.includes(query) ? plan : null
  }))
  return matches.filter(plan => plan !== null)
}
