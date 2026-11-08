import { apiError, forbidden } from '@/hosted/lib/api'
import { requireOwnerResponse } from '@/hosted/lib/auth'
import { isSameOriginRequest } from '@/hosted/lib/security'
import { revokeToken } from '@/hosted/lib/store'
import type { RequestHandler } from './$types'

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const denied = requireOwnerResponse(locals.auth)
  if (denied) return denied
  if (!isSameOriginRequest(request)) return forbidden()
  try { return Response.json({ revoked: await revokeToken(params.id) }) } catch (error) { return apiError(error) }
}
