// Runs the production build (`pnpm build:web` with VERCEL_ENV=production) using non-secret fixture
// values, so CI exercises the same fail-closed hosted environment guard Vercel runs on deploy.
// Every key comes from .env.example, so a new required key must be added there or this build fails.
// Fixture values are obviously fake and point at reserved `.invalid` hosts; nothing here is a secret.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const keys = readFileSync(resolve(root, '.env.example'), 'utf8')
  .split('\n')
  .map(line => line.trim().match(/^([A-Z0-9_]+)=/)?.[1])
  .filter(Boolean)

// Keys whose shape is validated need a well-formed fake; everything else gets a plain marker.
const shaped = {
  WORKOS_COOKIE_PASSWORD: 'ci-fixture-'.padEnd(40, 'x'),
  WORKOS_REDIRECT_URI: 'https://plans.example.invalid/callback',
  PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: 'https://auth.example.invalid',
  DATABASE_URL: 'postgres://db.example.invalid/ci-fixture',
}

const env = { ...process.env, VERCEL_ENV: 'production' }
for (const key of keys) env[key] = shaped[key] ?? `ci-fixture-${key.toLowerCase()}`

const result = spawnSync('pnpm', ['build:web'], { cwd: root, env, stdio: 'inherit' })
if (result.status !== 0) {
  process.stderr.write(
    '\nProduction-equivalent build failed. If the hosted environment check failed, a required key is\n'
    + 'missing from .env.example or the guard changed; add the key to .env.example and docs/hosting.md,\n'
    + 'then set it in Vercel (Production and Preview) before merging.\n',
  )
}
process.exit(result.status ?? 1)
