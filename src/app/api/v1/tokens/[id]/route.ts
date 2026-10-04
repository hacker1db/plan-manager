import { NextResponse } from "next/server"
import { apiError } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { revokeToken } from "@/hosted/lib/store"

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try { return NextResponse.json({ revoked: await revokeToken((await params).id) }) } catch (error) { return apiError(error) }
}
