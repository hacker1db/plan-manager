import { createHash, timingSafeEqual } from "node:crypto"
import { list } from "@vercel/blob"
import { jsonResponse, unauthorized } from "./api.ts"
import { getSql } from "./db.ts"
import { getCliOAuthConfiguration, getHealthDetailToken, getHostedEnvironment, HostedConfigurationError } from "./env.ts"

// Read-only dependency checks for /api/health/detail. Each answers only true/false: no error text,
// no IDs, no values ever leave the server. Every check is non-destructive.
export type HealthChecks = Record<"database" | "blob" | "workos" | "cliJwks", () => Promise<boolean>>

const TIMEOUT_MS = 5_000
const NO_STORE = { "Cache-Control": "no-store" } as const

async function fetchOk(url: string, init: RequestInit = {}): Promise<Response | null> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" })
  return response.ok ? response : null
}

const defaultChecks: HealthChecks = {
  // Neon reachable with the configured credentials.
  database: async () => (await getSql()`select 1 as ok`).length === 1,
  // Private Blob store reachable with the read/write token (list is read-only).
  blob: async () => Array.isArray((await list({ limit: 1, token: getHostedEnvironment().blobReadWriteToken })).blobs),
  // WORKOS_API_KEY accepted by an authenticated, read-only WorkOS call.
  workos: async () => Boolean(await fetchOk("https://api.workos.com/user_management/users?limit=1", { headers: { authorization: `Bearer ${getHostedEnvironment().workosApiKey}` } })),
  // The CLI audience's AuthKit JWKS is published.
  cliJwks: async () => {
    const response = await fetchOk(getCliOAuthConfiguration().jwksUrl)
    const body = response ? await response.json() as { keys?: unknown } : null
    return Array.isArray(body?.keys) && body.keys.length > 0
  },
}

let activeChecks: HealthChecks = defaultChecks
// Test seam, mirroring setEnvironmentSource(): lets tests replace network checks with fakes.
export function setHealthChecks(checks: HealthChecks | null) { activeChecks = checks ?? defaultChecks }

const digest = (value: string) => createHash("sha256").update(value).digest()

// Null when the request carries the configured bearer token; otherwise the response to return.
export function requireHealthDetailToken(request: Request): Response | null {
  let expected: string
  try {
    expected = getHealthDetailToken()
  } catch (error) {
    if (error instanceof HostedConfigurationError) return jsonResponse({ error: "Health detail is not configured" }, { status: 503, headers: NO_STORE })
    throw error
  }
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")
  if (!match || !timingSafeEqual(digest(match[1]), digest(expected))) return unauthorized()
  return null
}

export async function runHealthChecks(): Promise<{ ok: boolean; checks: Record<keyof HealthChecks, boolean> }> {
  const names = Object.keys(activeChecks) as (keyof HealthChecks)[]
  const results = await Promise.all(names.map(async name => {
    try {
      return await Promise.race([activeChecks[name](), new Promise<boolean>(resolve => setTimeout(resolve, TIMEOUT_MS + 1_000, false))]) === true
    } catch {
      return false
    }
  }))
  const checks = Object.fromEntries(names.map((name, index) => [name, results[index]])) as Record<keyof HealthChecks, boolean>
  return { ok: results.every(Boolean), checks }
}

export { NO_STORE as HEALTH_NO_STORE }
