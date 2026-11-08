// Fails the web build if server-only code or secret variable names reach browser assets.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const client = resolve(root, process.argv[2] ?? '.svelte-kit/output/client')
const FORBIDDEN = [
  'CLERK_SECRET_KEY',
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
    else if (/\.(js|mjs|css|html|json)$/.test(entry.name)) yield path
  }
}

const problems = []
let scanned = 0
for await (const file of files(client)) {
  scanned++
  const source = await readFile(file, 'utf8')
  for (const needle of FORBIDDEN) if (source.includes(needle)) problems.push(`${file.slice(root.length + 1)}: ${needle}`)
}
if (scanned === 0) throw new Error(`No client assets found in ${client}`)
if (problems.length) {
  process.stderr.write(`Server-only code reached the client bundle:\n${problems.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`Client bundle check passed (${scanned} files).\n`)
