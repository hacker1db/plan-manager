import { NextResponse } from "next/server"
import { apiError } from "../../../../../lib/api"
import { requireOwnerResponse } from "../../../../../lib/auth"
import { revokeToken } from "../../../../../lib/store"

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try { return NextResponse.json({ revoked: await revokeToken((await params).id) }) } catch (error) { return apiError(error) }
}
