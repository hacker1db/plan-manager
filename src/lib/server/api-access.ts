import { forbidden, unauthorized } from "./api.ts"
import { isAllowedOwner } from "./env.ts"

// Every /api route is owner-only by default (enforced in src/hooks.server.ts, in addition to the
// per-handler requireOwnerResponse/requireWriteToken guards). These are the only exceptions.
// Matching is exact on method and on an anchored path pattern; never a prefix match.
export type PublicApiRoute = {
  method: string
  pattern: RegExp
  // Route module that serves it, relative to the repository root.
  file: string
  // "none" is reserved for the nonsecret discovery document; anything else must be bearer-guarded.
  guard: "none" | "requireWriteToken"
}

export const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  // Public, versioned, nonsecret CLI discovery configuration.
  { method: "GET", pattern: /^\/api\/v1$/, file: "src/routes/api/v1/+server.ts", guard: "none" },
  // `plan push`: authenticated by bearer (pm_ token or WorkOS CLI JWT) inside the handler.
  { method: "PUT", pattern: /^\/api\/v1\/plans\/[A-Za-z0-9_-]{8,128}\/versions$/, file: "src/routes/api/v1/plans/[id]/versions/+server.ts", guard: "requireWriteToken" },
]

export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/")
}

export function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.some(route => route.method === method && route.pattern.test(path))
}

// Deny-by-default decision for an /api request: null allows the request through to its handler.
export function apiAccessDenial(
  method: string,
  path: string,
  user: { id: string } | null | undefined,
  source?: Readonly<Record<string, string | undefined>>,
): Response | null {
  if (isPublicApiRoute(method, path)) return null
  if (!user) return unauthorized()
  return isAllowedOwner(user.id, source) ? null : forbidden()
}
