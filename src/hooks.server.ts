import * as env from "$app/env/private"
import { setEnvironmentSource } from "#lib/server/env.ts"
import { createClerkAuthenticator } from "#lib/server/clerk.ts"
import { createHandle } from "#lib/server/gate.ts"

// Variables declared in src/env.ts; read from process.env on Vercel and .env files in `vite dev`.
setEnvironmentSource(env)

export const handle = createHandle(createClerkAuthenticator())
