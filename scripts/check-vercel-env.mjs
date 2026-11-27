// Compares the variable NAMES configured in Vercel against what the hosted build requires, per
// environment target, before a deploy fails. Reads only `vercel env ls --format json` metadata
// (key, target, type); it never requests, decrypts or prints a value. Required names per target come
// from config/env.contract.json.
//
//   vercel env ls --format json | node scripts/check-vercel-env.mjs [--target production]
//   pnpm check:vercel-env            (runs `vercel env ls` for the linked project)
import { spawnSync } from 'node:child_process'
import { TARGETS, loadContract, requiredNames } from './env-contract.mjs'

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const targets = targetIndex >= 0 ? [args[targetIndex + 1]] : TARGETS
if (targets.some(target => !TARGETS.includes(target))) {
  process.stderr.write(`--target must be one of ${TARGETS.join(', ')}\n`)
  process.exit(2)
}

async function readInventory() {
  if (!process.stdin.isTTY && !args.includes('--fetch')) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    if (text.trim()) return text
  }
  const result = spawnSync('vercel', ['env', 'ls', '--format', 'json'], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write('Could not list Vercel environment variable names; link the project with `vercel link` first.\n')
    process.exit(2)
  }
  return result.stdout
}

let entries
try {
  const parsed = JSON.parse(await readInventory())
  entries = Array.isArray(parsed) ? parsed : parsed.envs
  if (!Array.isArray(entries)) throw new Error()
} catch {
  process.stderr.write('Vercel inventory is not `vercel env ls --format json` output.\n')
  process.exit(2)
}

const configured = new Map(TARGETS.map(target => [target, new Set()]))
for (const entry of entries) {
  if (typeof entry?.key !== 'string') continue
  const entryTargets = Array.isArray(entry.target) ? entry.target : [entry.target]
  for (const target of entryTargets) configured.get(target)?.add(entry.key)
}

const contract = loadContract()
let failed = false
for (const target of targets) {
  const required = requiredNames(contract, target)
  const missing = required.filter(key => !configured.get(target).has(key))
  if (missing.length === 0) {
    process.stdout.write(`${target}: all ${required.length} hosted variable names present.\n`)
  } else {
    failed = true
    process.stdout.write(`${target}: missing ${missing.length} of ${required.length} hosted variable names:\n${missing.map(key => `  - ${key}`).join('\n')}\n`)
  }
}
if (failed) process.stdout.write('Names only: presence here does not validate values. See docs/hosting.md "Vercel environment configuration".\n')
process.exit(failed ? 1 : 0)
