// Runs the production build (`pnpm build:web` with VERCEL_ENV=production) using the non-secret
// `ciFixture` values from config/env.contract.json, so CI exercises the same fail-closed hosted
// environment guard Vercel runs on deploy. Fixtures are obviously fake and point at reserved
// `.invalid` hosts; nothing here is a secret. The developer's own variables are dropped so a
// local .env cannot mask a missing fixture.
import { spawnSync } from 'node:child_process'
import { fixtureEnvironment, loadContract, root, vercelVariables } from './env-contract.mjs'

const contract = loadContract()
const env = { ...process.env, VERCEL_ENV: 'production' }
for (const variable of vercelVariables(contract)) delete env[variable.name]
Object.assign(env, fixtureEnvironment(contract))

const result = spawnSync('pnpm', ['build:web'], { cwd: root, env, stdio: 'inherit' })
if (result.status !== 0) {
  process.stderr.write(
    '\nProduction-equivalent build failed. If the hosted environment check failed, a required key is\n'
    + 'missing a ciFixture in config/env.contract.json or the guard changed. Add it to the contract,\n'
    + 'run `pnpm contract:generate`, and set it in Vercel (Production and Preview) before merging.\n',
  )
}
process.exit(result.status ?? 1)
