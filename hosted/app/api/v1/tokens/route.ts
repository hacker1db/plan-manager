import { NextResponse } from "next/server"
import { apiError } from "../../../../lib/api"
import { requireOwnerResponse } from "../../../../lib/auth"
import { getHostedEnvironment } from "../../../../lib/env"
import { createToken } from "../../../../lib/store"
import { generateToken, hashSecret, isPlanScope } from "../../../../lib/token"
import type { PlanScope } from "../../../../lib/types"

export async function POST(request: Request) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try {
    const body = await request.json() as { scopes?: unknown; expiresAt?: unknown }
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every((scope): scope is PlanScope => typeof scope === "string" && isPlanScope(scope))) throw new Error("Invalid token scopes")
    const expiresAt = new Date(typeof body.expiresAt === "string" ? body.expiresAt : "")
    if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= new Date()) throw new Error("Invalid token expiration")
    const generated = generateToken()
    const token = await createToken({ id: generated.id, scopes: body.scopes, expiresAt, revokedAt: null, secretHash: await hashSecret(generated.secret, getHostedEnvironment().tokenPepper) })
    return NextResponse.json({ version: 1, token, bearer: generated.bearer }, { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
