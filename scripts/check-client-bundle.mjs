// Fails the web build if server-only code, secret variable names, or source maps
// reach browser assets. Source maps would publish the original server-adjacent source.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const client = resolve(root, process.argv[2] ?? '.svelte-kit/output/client')
const FORBIDDEN = [
  'CLERK_SECRET_KEY',
  'WORKOS_API_KEY',
  'WORKOS_COOKIE_PASSWORD',
  'PLAN_MANAGER_OWNER_WORKOS_USER_IDS',
  'PLAN_MANAGER_TOKEN_PEPPER',
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  'PLAN_MANAGER_OAUTH_CLIENT_ID',
  'PLAN_MANAGER_OWNER_CLERK_USER',
  'authenticateRequest',
  'secret_hash',
  'renderToStaticMarkup',
  '@neondatabase',
]

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

const problems = []
let scanned = 0
for await (const file of files(client)) {
  if (/\.map$/i.test(file)) {
    problems.push(`${relative(root, file)}: source map`)
    continue
  }
  if (!/\.(js|mjs|css|html|json)$/.test(file)) continue
  scanned++
  const source = await readFile(file, 'utf8')
  for (const needle of FORBIDDEN) if (source.includes(needle)) problems.push(`${relative(root, file)}: ${needle}`)
  if (/[#@]\s*sourceMappingURL=/.test(source)) problems.push(`${relative(root, file)}: sourceMappingURL`)
}
if (scanned === 0) throw new Error(`No client assets found in ${client}`)
if (problems.length) {
  process.stderr.write(`Server-only code or source maps reached the client bundle:\n${problems.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`Client bundle check passed (${scanned} files).\n`)
