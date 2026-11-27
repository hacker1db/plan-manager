import { startSignIn } from '#lib/server/sign-in.ts'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = ({ url }) => startSignIn(url)
