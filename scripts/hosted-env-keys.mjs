// Single source for the hosted variable NAMES the production build and the Vercel inventory check
// require. REQUIRED_KEYS lives in src/lib/server/env.ts; it is parsed from there so the build guard,
// the inventory check and the runtime check cannot drift apart. Never handles values.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const OWNER_KEY = 'PLAN_MANAGER_OWNER_WORKOS_USER_IDS'
export const CLI_KEYS = [
  'PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN',
  'PLAN_MANAGER_WORKOS_CLI_CLIENT_ID',
  'PLAN_MANAGER_WORKOS_CLI_AUDIENCE',
]

export async function runtimeRequiredKeys() {
  const source = await readFile(resolve(root, 'src/lib/server/env.ts'), 'utf8')
  const match = source.match(/const REQUIRED_KEYS = \[([^\]]*)\]/)
  const keys = match ? [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map(item => item[1]) : []
  if (keys.length === 0) throw new Error('could not read REQUIRED_KEYS from src/lib/server/env.ts')
  return keys
}

export async function hostedRequiredKeys() {
  return [...new Set([...(await runtimeRequiredKeys()), OWNER_KEY, ...CLI_KEYS])]
}
