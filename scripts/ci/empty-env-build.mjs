// Negative check: a VERCEL_ENV=production `pnpm build:web` with none of the contract variables set
// must fail, and its output must name every production-required variable. Proves the build guard
// is still wired into the build and still fails closed.
import { spawnSync } from 'node:child_process'
import { loadContract, requiredNames, root, vercelVariables } from '../env-contract.mjs'

const contract = loadContract()
const env = { ...process.env, VERCEL_ENV: 'production' }
for (const variable of vercelVariables(contract)) delete env[variable.name]

const result = spawnSync('pnpm', ['build:web'], { cwd: root, env, encoding: 'utf8' })
const output = `${result.stdout}${result.stderr}`
const listed = new Set([...output.matchAll(/^ {2}- ([A-Z0-9_]+)$/gm)].map(match => match[1]))
const unnamed = requiredNames(contract, 'production').filter(name => !listed.has(name))

if (result.status === 0) {
  process.stderr.write('Empty-environment production build SUCCEEDED; the hosted environment guard is not failing closed.\n')
  process.exit(1)
}
if (unnamed.length > 0) {
  process.stderr.write(`Empty-environment production build failed but did not name:\n${unnamed.map(name => `  - ${name}`).join('\n')}\n${output}`)
  process.exit(1)
}
process.stdout.write(`Empty-environment production build failed as required, naming all ${listed.size} production variables.\n`)
