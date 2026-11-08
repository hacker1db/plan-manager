import { getCliOAuthConfiguration, HostedConfigurationError } from '#lib/server/env.ts'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = () => {
  try {
    return Response.json(getCliOAuthConfiguration(), { headers: { 'Cache-Control': 'public, max-age=300' } })
  } catch (error) {
    if (error instanceof HostedConfigurationError) return Response.json({ error: 'CLI authentication is not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    throw error
  }
}
