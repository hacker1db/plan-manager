import { jsonResponse } from '#lib/server/api.ts'
import { HEALTH_NO_STORE, requireHealthDetailToken, runHealthChecks } from '#lib/server/health.ts'
import type { RequestHandler } from './$types'

// Per-dependency booleans for release checks. Requires `Authorization: Bearer <PLAN_MANAGER_HEALTH_DETAIL_TOKEN>`.
export const GET: RequestHandler = async ({ request }) => {
  const denied = requireHealthDetailToken(request)
  if (denied) return denied
  const { ok, checks } = await runHealthChecks()
  return jsonResponse({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503, headers: HEALTH_NO_STORE })
}
