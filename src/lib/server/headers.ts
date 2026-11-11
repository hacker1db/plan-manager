import { FALLBACK_CSP } from "./csp.ts"

// Hardening headers applied to every response by src/hooks.server.ts. The page CSP comes from
// SvelteKit's `csp` option (see csp.ts); FALLBACK_CSP covers responses that carry no policy.
export const securityHeaders: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}

function apply(headers: Headers): void {
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value)
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", FALLBACK_CSP)
}

export function withSecurityHeaders(response: Response): Response {
  try {
    apply(response.headers)
    return response
  } catch {
    // Immutable headers (e.g. Response.redirect or fetch results): copy into a mutable response.
    const copy = new Response(response.body, response)
    apply(copy.headers)
    return copy
  }
}
