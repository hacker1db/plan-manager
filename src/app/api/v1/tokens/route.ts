import { NextResponse } from "next/server"
import { apiError, forbidden } from "@/hosted/lib/api"
import { requireOwnerResponse } from "@/hosted/lib/auth"
import { isJsonRequest, isSameOriginRequest } from "@/hosted/lib/security"
import { getHostedEnvironment } from "@/hosted/lib/env"
import { createToken } from "@/hosted/lib/store"
import { generateToken, hashSecret, isPlanScope } from "@/hosted/lib/token"
import type { PlanScope } from "@/hosted/lib/types"

export async function POST(request: Request) {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  if (!isJsonRequest(request)) return NextResponse.json({ error: "Expected JSON" }, { status: 415 })
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body) || !("scopes" in body) || !("expiresAt" in body)) throw new Error("Invalid token request")
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every((scope): scope is PlanScope => typeof scope === "string" && isPlanScope(scope))) throw new Error("Invalid token scopes")
    const expiresAt = new Date(typeof body.expiresAt === "string" ? body.expiresAt : "")
    if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= new Date()) throw new Error("Invalid token expiration")
    const generated = generateToken()
    const token = await createToken({ id: generated.id, scopes: body.scopes, expiresAt, revokedAt: null, secretHash: await hashSecret(generated.secret, getHostedEnvironment().tokenPepper) })
    return NextResponse.json({ version: 1, token, bearer: generated.bearer }, { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
