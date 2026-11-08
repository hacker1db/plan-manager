import { apiError, forbidden } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { getHostedEnvironment } from '@/hosted/lib/env'
import { isJsonRequest, isSameOriginRequest } from '@/hosted/lib/security'
import { createToken } from '@/hosted/lib/store'
import { generateToken, hashSecret, isPlanScope } from '@/hosted/lib/token'
import type { PlanScope } from '@/hosted/lib/types'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ locals, request }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  if (!isJsonRequest(request)) return Response.json({ error: 'Expected JSON' }, { status: 415 })
  try {
    const body = await request.json() as { scopes?: unknown; expiresAt?: unknown }
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every((scope): scope is PlanScope => typeof scope === 'string' && isPlanScope(scope))) return Response.json({ error: 'Invalid token scopes' }, { status: 400 })
    const expiresAt = new Date(typeof body.expiresAt === 'string' ? body.expiresAt : '')
    if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= new Date()) return Response.json({ error: 'Invalid token expiration' }, { status: 400 })
    const generated = generateToken()
    const token = await createToken({ id: generated.id, scopes: body.scopes, expiresAt, revokedAt: null, secretHash: await hashSecret(generated.secret, getHostedEnvironment().tokenPepper) })
    return Response.json({ version: 1, token, bearer: generated.bearer }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return apiError(error) }
}
