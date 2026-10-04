import { NextResponse } from "next/server"
import { apiError, forbidden, publicPlan } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { updatePlanStatus } from "@/hosted/lib/store"
import { isSameOriginRequest } from "@/hosted/lib/security"
import { isPlanStatus } from "@/lib/types"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try {
    const input: unknown = await request.json()
    if (!input || typeof input !== "object" || Array.isArray(input) || !("status" in input) || !isPlanStatus(input.status)) {
      return NextResponse.json({ error: "Invalid plan status" }, { status: 400 })
    }
    const result = await updatePlanStatus((await params).id, input.status)
    if (!result.plan) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.conflict) return NextResponse.json({ error: "Plan changed concurrently", currentRevision: result.plan.revision }, { status: 409 })
    return NextResponse.json({ ...publicPlan(result.plan), url: `/plans/${encodeURIComponent(result.plan.id)}`, isArchived: result.plan.status === "archived" }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
