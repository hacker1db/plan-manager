import { environmentSource, getClerkSignInUrl } from "$lib/server/env.ts"
import type { LayoutServerLoad } from "./$types"

// Only the publishable key (public by design) and the optional sign-in URL reach the
// browser; CLERK_SECRET_KEY and every other server variable stay in $lib/server.
export const load: LayoutServerLoad = () => {
  const env = environmentSource()
  const publishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
  return { clerk: publishableKey ? { publishableKey, signInUrl: getClerkSignInUrl(env) ?? null } : null }
}
