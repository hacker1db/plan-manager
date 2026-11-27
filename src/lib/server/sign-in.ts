import { authKit } from '@workos/authkit-sveltekit'
import { redirect } from '@sveltejs/kit'

export const DEFAULT_RETURN_TO = '/plans'
const AUTH_PATHS = new Set(['/login', '/sign-in', '/callback', '/sign-out'])
const BASE = 'https://plan-manager.invalid'
// Leaves headroom under AuthKit's 3800-byte sealed PKCE cookie for long redirect URIs.
const MAX_RETURN_TO = 1024

/** Accept only a same-origin absolute path; anything else falls back to the default. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > MAX_RETURN_TO || !value.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_TO
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN_TO
  let parsed: URL
  try { parsed = new URL(value, BASE) } catch { return DEFAULT_RETURN_TO }
  // Validate the NORMALIZED path, not the raw input: dot segments ("/.//x", "/%2e//x") collapse to
  // "//x", which a browser reads as a protocol-relative URL to another host.
  const path = parsed.pathname
  if (parsed.origin !== BASE || !path.startsWith('/') || path.startsWith('//')) return DEFAULT_RETURN_TO
  // Match routes the way SvelteKit dispatches them (decodeURI), so "/%6cogin" cannot loop back
  // into an auth route. Malformed escapes are rejected.
  let decoded: string
  try { decoded = decodeURI(path) } catch { return DEFAULT_RETURN_TO }
  const route = decoded.toLowerCase().replace(/\/+$/, '') || '/'
  if (AUTH_PATHS.has(route) || route === '/auth' || route.startsWith('/auth/')) return DEFAULT_RETURN_TO
  // Cap the SERIALIZED value: URL parsing percent-expands quotes, spaces and non-ASCII up to 12x,
  // and AuthKit seals returnTo into a cookie that throws above ~3800 bytes.
  const normalized = `${path}${parsed.search}${parsed.hash}`
  if (normalized.length > MAX_RETURN_TO) return DEFAULT_RETURN_TO
  return normalized
}

/** `/login?returnTo=<safe path>` for an unauthenticated request to `url`. */
export function loginLocation(url: URL): string {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(`${url.pathname}${url.search}`))}`
}

/** Shared by /login and /sign-in: start the WorkOS AuthKit sign-in flow. */
export async function startSignIn(url: URL): Promise<never> {
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'))
  throw redirect(303, await authKit.getSignInUrl({ returnTo }), { external: ['https://api.workos.com'] })
}
