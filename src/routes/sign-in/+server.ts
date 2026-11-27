import { startSignIn } from '#lib/server/sign-in.ts'
import type { RequestHandler } from './$types'

// Kept for the WorkOS-registered `initiate_login_uri`; /login is the user-facing entry point.
export const GET: RequestHandler = ({ url }) => startSignIn(url)
