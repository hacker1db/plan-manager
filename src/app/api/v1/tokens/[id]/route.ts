import { NextResponse } from "next/server"
import { apiError, forbidden } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { isSameOriginRequest } from "@/hosted/lib/security"
import { revokeToken } from "@/hosted/lib/store"

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try { return NextResponse.json({ revoked: await revokeToken((await params).id) }) } catch (error) { return apiError(error) }
}
