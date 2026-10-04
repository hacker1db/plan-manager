import { NextResponse } from "next/server"
import { apiError, publicPlan } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { findPlan, readMarkdown } from "@/hosted/lib/store"

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try {
    const plan = await findPlan((await params).id)
    if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({
      ...publicPlan(plan),
      markdown: await readMarkdown(plan),
      url: `/plans/${encodeURIComponent(plan.id)}`,
      isArchived: plan.status === "archived",
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
