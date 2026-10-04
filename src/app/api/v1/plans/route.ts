import { NextResponse } from "next/server"
import { apiError, publicPlan } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { listPlans, readMarkdown } from "@/hosted/lib/store"

export async function GET(request: Request) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try {
    const plans = await listPlans()
    const query = new URL(request.url).searchParams.get("q")?.trim().toLowerCase().slice(0, 256)
    const matches = !query ? plans : (await Promise.all(plans.map(async plan => {
      const text = `${plan.title} ${plan.tags.join(" ")} ${await readMarkdown(plan)}`.toLowerCase()
      return text.includes(query) ? plan : null
    }))).filter(plan => plan !== null)
    return NextResponse.json({ version: 1, plans: matches.map(publicPlan) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
