import { jsonResponse } from '#lib/server/api.ts'
import { ownerConfigured } from '#lib/server/env.ts'
import type { RequestHandler } from './$types'

// Public, nonsecret liveness: says only whether this deployment is up and fully configured.
// Dependency detail is behind /api/health/detail.
export const GET: RequestHandler = () => {
  const configured = ownerConfigured()
  return jsonResponse({ status: configured ? 'ok' : 'unconfigured' }, { status: configured ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
