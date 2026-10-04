import { auth } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import { getHostedEnvironment, HostedConfigurationError } from "./env"
import { forbidden, unauthorized } from "./api"
import { findToken } from "./store"
import { parseBearer, tokenAuthorizes } from "./token"
import type { PlanScope } from "./types"

export async function ownerId(): Promise<string | null> {
  const { userId } = await auth()
  return userId
}

export async function requireOwnerResponse(): Promise<NextResponse | null> {
  try {
    const userId = await ownerId()
    if (!userId) return unauthorized()
    return userId === getHostedEnvironment().ownerClerkUserId ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return NextResponse.json({ error: "Hosted service is unavailable" }, { status: 503 })
    throw error
  }
}

export async function requireWriteToken(request: Request, scope: PlanScope): Promise<NextResponse | null> {
  const parsed = parseBearer(request.headers.get("authorization"))
  if (!parsed) return unauthorized()
  try {
    const record = await findToken(parsed.id)
    return await tokenAuthorizes(record, parsed.secret, getHostedEnvironment().tokenPepper, scope) ? null : forbidden()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return NextResponse.json({ error: "Hosted service is unavailable" }, { status: 503 })
    throw error
  }
}
