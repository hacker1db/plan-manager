import { HostedConfigurationError } from "./env.ts"

// Framework-neutral JSON helpers: route handlers return standard Responses so the
// status codes and bodies stay identical to the former Next.js route handlers.
export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(value), { ...init, headers })
}

export const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const

export function apiError(error: unknown): Response {
  if (error instanceof HostedConfigurationError) return unavailable()
  if (error instanceof SyntaxError) return jsonResponse({ error: "Invalid JSON" }, { status: 400 })
  return jsonResponse({ error: "Request failed" }, { status: 500 })
}

export function publicPlan<T extends { objectKey: string }>(plan: T): Omit<T, "objectKey"> {
  const { objectKey, ...metadata } = plan
  return metadata
}

export function forbidden(): Response {
  return jsonResponse({ error: "Forbidden" }, { status: 403 })
}

export function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, { status: 401 })
}

export function notFound(): Response {
  return jsonResponse({ error: "Not found" }, { status: 404 })
}

export function unavailable(): Response {
  return jsonResponse({ error: "Hosted service is unavailable" }, { status: 503 })
}
