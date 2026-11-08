import { env } from "$env/dynamic/private"
import { setEnvironmentSource } from "$lib/server/env.ts"
import { createClerkAuthenticator } from "$lib/server/clerk.ts"
import { createHandle } from "$lib/server/gate.ts"

// $env/dynamic/private is process.env on Vercel and includes .env files in `vite dev`.
setEnvironmentSource(env)

export const handle = createHandle(createClerkAuthenticator())
