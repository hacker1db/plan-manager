import { NextResponse } from "next/server"
import { apiError, forbidden, publicPlan } from "@/hosted/lib/api"
import { requireWriteToken } from "@/hosted/lib/auth"
import { writePlan } from "@/hosted/lib/store"
import { requirePlanId } from "@/hosted/lib/sanitize"
import type { HostedPlanInput } from "@/hosted/lib/types"

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriteToken(request, "plans:write")
  if (denied) return denied
  try {
    const id = requirePlanId((await params).id)
    const body = await request.json() as HostedPlanInput
    if (body.id !== id) return forbidden()
    const result = await writePlan(body)
    if (result.conflict) return NextResponse.json({ error: "Revision conflict", currentRevision: result.plan?.revision ?? null }, { status: 409 })
    return NextResponse.json({ version: 1, plan: publicPlan(result.plan), url: `/plans/${result.plan.id}` }, { status: 201, headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
