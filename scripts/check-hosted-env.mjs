// Fails a Vercel production build when the hosted runtime configuration is incomplete, so a
// deployment that would only answer 503 never goes live. Prints variable NAMES only, never values.
// Outside VERCEL_ENV=production this script does nothing.
import { CLI_KEYS, OWNER_KEY, runtimeRequiredKeys } from './hosted-env-keys.mjs'

if (process.env.VERCEL_ENV !== 'production') process.exit(0)

const MIN_COOKIE_PASSWORD_LENGTH = 32

async function requiredKeys() {
  try {
    return await runtimeRequiredKeys()
  } catch (error) {
    process.stderr.write(`Hosted environment check failed: ${error.message}.\n`)
    process.exit(1)
  }
}

const present = key => Boolean(process.env[key]?.trim())
const ownerIds = (process.env.PLAN_MANAGER_OWNER_WORKOS_USER_IDS ?? '').split(',').map(item => item.trim()).filter(Boolean)

const missing = new Set([
  ...(await requiredKeys()).filter(key => !present(key)),
  ...(ownerIds.length === 0 ? [OWNER_KEY] : []),
  ...((process.env.WORKOS_COOKIE_PASSWORD?.length ?? 0) < MIN_COOKIE_PASSWORD_LENGTH ? ['WORKOS_COOKIE_PASSWORD'] : []),
  ...CLI_KEYS.filter(key => !present(key)),
])

if (missing.size > 0) {
  process.stderr.write(
    'Hosted environment check failed for VERCEL_ENV=production. Missing or invalid variables:\n'
    + [...missing].map(key => `  - ${key}`).join('\n')
    + `\nSet them in Vercel (WORKOS_COOKIE_PASSWORD needs at least ${MIN_COOKIE_PASSWORD_LENGTH} characters); see docs/hosting.md and run "pnpm check:vercel-env" to compare Vercel names per environment.\n`,
  )
  process.exit(1)
}
process.stdout.write('Hosted environment check passed.\n')
