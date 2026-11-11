// Fails a Vercel production build when the hosted runtime configuration is incomplete, so a
// deployment that would only answer 503 never goes live. Prints variable NAMES only, never values.
// Outside VERCEL_ENV=production this script does nothing.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.VERCEL_ENV !== 'production') process.exit(0)

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MIN_COOKIE_PASSWORD_LENGTH = 32
const CLI_KEYS = [
  'PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN',
  'PLAN_MANAGER_WORKOS_CLI_CLIENT_ID',
  'PLAN_MANAGER_WORKOS_CLI_AUDIENCE',
]

// REQUIRED_KEYS is defined once, in src/lib/server/env.ts; read it from there so the build guard
// and the runtime check cannot drift apart.
async function requiredKeys() {
  const source = await readFile(resolve(root, 'src/lib/server/env.ts'), 'utf8')
  const match = source.match(/const REQUIRED_KEYS = \[([^\]]*)\]/)
  const keys = match ? [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map(item => item[1]) : []
  if (keys.length === 0) {
    process.stderr.write('Hosted environment check failed: could not read REQUIRED_KEYS from src/lib/server/env.ts.\n')
    process.exit(1)
  }
  return keys
}

const present = key => Boolean(process.env[key]?.trim())
const ownerIds = (process.env.PLAN_MANAGER_OWNER_WORKOS_USER_IDS ?? '').split(',').map(item => item.trim()).filter(Boolean)

const missing = new Set([
  ...(await requiredKeys()).filter(key => !present(key)),
  ...(ownerIds.length === 0 ? ['PLAN_MANAGER_OWNER_WORKOS_USER_IDS'] : []),
  ...((process.env.WORKOS_COOKIE_PASSWORD?.length ?? 0) < MIN_COOKIE_PASSWORD_LENGTH ? ['WORKOS_COOKIE_PASSWORD'] : []),
  ...CLI_KEYS.filter(key => !present(key)),
])

if (missing.size > 0) {
  process.stderr.write(
    'Hosted environment check failed for VERCEL_ENV=production. Missing or invalid variables:\n'
    + [...missing].map(key => `  - ${key}`).join('\n')
    + `\nSet them in Vercel (WORKOS_COOKIE_PASSWORD needs at least ${MIN_COOKIE_PASSWORD_LENGTH} characters); see docs/hosting.md.\n`,
  )
  process.exit(1)
}
process.stdout.write('Hosted environment check passed.\n')
