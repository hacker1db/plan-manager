import { jsonResponse } from "#lib/server/api.ts"
import { HostedConfigurationError, getCliOAuthConfiguration } from "#lib/server/env.ts"
import type { RequestHandler } from "./$types"

// Public: the CLI discovers its Clerk OAuth client ID and issuer here before login.
export const GET: RequestHandler = () => {
  try {
    return jsonResponse({ version: 1, ...getCliOAuthConfiguration() }, { headers: { "Cache-Control": "public, max-age=300" } })
  } catch (error) {
    if (error instanceof HostedConfigurationError) return jsonResponse({ error: "CLI authentication is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } })
    throw error
  }
}
