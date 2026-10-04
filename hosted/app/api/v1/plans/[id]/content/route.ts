import { NextResponse } from "next/server"
import { apiError } from "../../../../../../lib/api"
import { requireOwnerResponse } from "../../../../../../lib/auth"
import { findPlan, readMarkdown } from "../../../../../../lib/store"

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try {
    const plan = await findPlan((await params).id)
    if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return new NextResponse(await readMarkdown(plan), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${plan.id}.md"`, "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
