import { createHash } from "node:crypto"
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
    const fingerprint = createHash("sha256").update(plans.map(plan => `${plan.id}:${plan.revision}`).join("\n")).digest("hex")
    return NextResponse.json({
      plans: matches.map(plan => ({ ...publicPlan(plan), url: `/plans/${encodeURIComponent(plan.id)}`, isArchived: plan.status === "archived" })),
      malformed: [],
      fingerprint,
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
