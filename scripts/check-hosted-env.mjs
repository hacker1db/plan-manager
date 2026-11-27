// Fails a Vercel production build when the hosted runtime configuration is incomplete, so a
// deployment that would only answer 503 never goes live. Every production-required name and its
// check come from config/env.contract.json. Prints variable NAMES only, never values.
// Outside VERCEL_ENV=production this script does nothing.
import { describeValidator, loadContract, missingOrInvalid, requiredIn } from './env-contract.mjs'

if (process.env.VERCEL_ENV !== 'production') process.exit(0)

let contract
try {
  contract = loadContract()
} catch (error) {
  // Fail closed: an unreadable contract must never let a production build through.
  process.stderr.write(`Hosted environment check failed: ${error.message}\n`)
  process.exit(1)
}

const missing = new Set(missingOrInvalid(contract, process.env, 'production'))
if (missing.size > 0) {
  const checks = requiredIn(contract, 'production').filter(variable => missing.has(variable.name) && variable.validator.id !== 'nonEmpty')
  process.stderr.write(
    'Hosted environment check failed for VERCEL_ENV=production. Missing or invalid variables:\n'
    + [...missing].map(key => `  - ${key}`).join('\n')
    + `\n${checks.map(variable => `${variable.name} must be ${describeValidator(variable.validator)}. `).join('')}`
    + 'Set them in Vercel; see docs/hosting.md and run "pnpm check:vercel-env" to compare Vercel names per environment.\n',
  )
  process.exit(1)
}
process.stdout.write('Hosted environment check passed.\n')
