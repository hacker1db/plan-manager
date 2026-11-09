import { authKit } from '@workos/authkit-sveltekit'
import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

// Sign-out changes session state, so it is POST-only and requires a same-origin Origin header
// (defense in depth on top of SvelteKit's built-in CSRF check for form submissions).
export const POST: RequestHandler = event => {
  if (event.request.headers.get('origin') !== event.url.origin) return new Response('Cross-site sign-out rejected', { status: 403 })
  return authKit.signOut(event)
}

// A GET (e.g. a cross-site link or <img>) must never end the session.
export const GET: RequestHandler = () => {
  throw redirect(303, '/')
}
