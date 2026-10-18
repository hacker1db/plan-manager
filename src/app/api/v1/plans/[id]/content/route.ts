import { NextResponse } from "next/server"
import { apiError } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { findPlan, readMarkdown } from "@/hosted/lib/store"
import { extensionFor, sourceFormat } from "@/lib/mdx/format"

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try {
    const plan = await findPlan((await params).id)
    if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const markdown = await readMarkdown(plan)
    const extension = extensionFor(sourceFormat(markdown))
    return new NextResponse(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${plan.id}${extension}"`, "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
