import { authKit } from '@workos/authkit-sveltekit'
import { redirect } from '@sveltejs/kit'

export const DEFAULT_RETURN_TO = '/plans'
const AUTH_PATHS = new Set(['/login', '/sign-in', '/callback', '/sign-out'])
const BASE = 'https://plan-manager.invalid'

/** Accept only a same-origin absolute path; anything else falls back to the default. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_TO
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN_TO
  let parsed: URL
  try { parsed = new URL(value, BASE) } catch { return DEFAULT_RETURN_TO }
  if (parsed.origin !== BASE || AUTH_PATHS.has(parsed.pathname) || parsed.pathname.startsWith('/auth/')) return DEFAULT_RETURN_TO
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
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
