import { authKit } from '@workos/authkit-sveltekit'
import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async () => {
  throw redirect(303, await authKit.getSignInUrl({ returnTo: '/plans' }), { external: ['https://api.workos.com'] })
}
