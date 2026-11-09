import type { PageServerLoad } from './$types'

const knownCodes = new Set([
  'ACCESS_DENIED',
  'AUTH_ERROR',
  'AUTH_FAILED',
  'STATE_MISMATCH',
  'PKCE_COOKIE_MISSING',
  'SESSION_ENCRYPTION_FAILED',
])

export const load: PageServerLoad = ({ url }) => {
  const code = url.searchParams.get('code')
  return { code: code && knownCodes.has(code) ? code : 'AUTH_FAILED' }
}
