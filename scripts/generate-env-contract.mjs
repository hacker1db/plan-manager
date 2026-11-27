// Generates every file derived from config/env.contract.json, in a fixed order, from the contract's
// authored variable order. Output is a pure function of the contract, so `--check` is stable.
//
//   node scripts/generate-env-contract.mjs          write the generated files   (pnpm contract:generate)
//   node scripts/generate-env-contract.mjs --check  exit 1 if any file differs  (pnpm contract:check)
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT_PATH, ContractError, TARGETS, describeValidator, loadContract, minimumStorage, root, vercelVariables } from './env-contract.mjs'

const HEADER = `Generated from ${CONTRACT_PATH} by scripts/generate-env-contract.mjs. Do not edit; run \`pnpm contract:generate\`.`
const DOCS_PATH = 'docs/hosting.md'
const DOCS_BEGIN = '<!-- env-contract:begin -->'
const DOCS_END = '<!-- env-contract:end -->'

function runtimeModule(contract) {
  const entries = group => vercelVariables(contract)
    .filter(variable => variable.group === group)
    .map(variable => `  { name: ${JSON.stringify(variable.name)}, validator: { ${Object.entries(variable.validator).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')} } },`)
    .join('\n')
  return `// ${HEADER}
export type EnvValidator =
  | { readonly id: "nonEmpty" }
  | { readonly id: "csvNonEmpty" }
  | { readonly id: "minLength"; readonly min: number }

export type ContractVariable = { readonly name: string; readonly validator: EnvValidator }

// Required by getHostedEnvironment(), in contract order.
export const HOSTED_RUNTIME_VARIABLES = [
${entries('hosted')}
] as const satisfies readonly ContractVariable[]

// Required by getCliOAuthConfiguration(), in contract order.
export const CLI_RUNTIME_VARIABLES = [
${entries('cli')}
] as const satisfies readonly ContractVariable[]
`
}

function svelteEnvModule(contract) {
  return `// ${HEADER}
// SvelteKit 3 requires every private deployment variable to be declared here.
import {defineEnvVars} from "@sveltejs/kit/env"
const optional = {schema: (value: string | undefined) => value}
export const variables = defineEnvVars({
${vercelVariables(contract).map(variable => `  ${variable.name}: optional,`).join('\n')}
})
`
}

function envExample(contract) {
  return `# ${HEADER}
# Keep values empty here; set real values in Vercel or .env.local only.
${vercelVariables(contract).map(variable => `${variable.name}=`).join('\n')}
`
}

function docsTable(contract) {
  const rows = contract.variables.map(variable => {
    const where = variable.store === 'vercel'
      ? (variable.requiredIn.length ? variable.requiredIn.join(', ') : 'optional')
      : `GitHub environment: ${variable.githubEnvironments.join(', ')}`
    const storage = variable.store === 'vercel'
      ? TARGETS.filter(target => variable.requiredIn.includes(target)).map(target => `${target}: ${minimumStorage(contract, variable, target)}`).join('; ') || '—'
      : 'GitHub environment secret'
    return `| \`${variable.name}\` | ${where} | ${variable.sensitivity} | ${describeValidator(variable.validator)} | ${storage} | ${variable.description} |`
  })
  return [
    DOCS_BEGIN,
    `<!-- ${HEADER} -->`,
    '',
    '| Name | Required in | Sensitivity | Build check | Minimum Vercel storage type | Purpose |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    DOCS_END,
  ].join('\n')
}

function withDocsTable(current, contract) {
  const begin = current.indexOf(DOCS_BEGIN)
  const end = current.indexOf(DOCS_END)
  if (begin < 0 || end < begin) throw new ContractError([`${DOCS_PATH} must contain ${DOCS_BEGIN} ... ${DOCS_END}`])
  return current.slice(0, begin) + docsTable(contract) + current.slice(end + DOCS_END.length)
}

// Fixed order: runtime module, SvelteKit declaration, .env.example, docs table.
export function generatedFiles(contract, readCurrent = path => readFileSync(resolve(root, path), 'utf8')) {
  return [
    ['src/lib/server/env.contract.ts', runtimeModule(contract)],
    ['src/env.ts', svelteEnvModule(contract)],
    ['.env.example', envExample(contract)],
    [DOCS_PATH, withDocsTable(readCurrent(DOCS_PATH), contract)],
  ]
}

const readOrNull = path => {
  try { return readFileSync(resolve(root, path), 'utf8') } catch { return null }
}

// Paths whose committed content differs from what the contract generates.
export function staleFiles(contract, read = readOrNull) {
  return generatedFiles(contract, path => read(path) ?? '').filter(([path, content]) => read(path) !== content).map(([path]) => path)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check')
  try {
    const contract = loadContract()
    const stale = staleFiles(contract)
    if (stale.length && check) {
      process.stderr.write(`Generated files are out of date with ${CONTRACT_PATH}:\n${stale.map(path => `  - ${path}`).join('\n')}\nRun \`pnpm contract:generate\` and commit the result.\n`)
      process.exit(1)
    }
    if (!check) for (const [path, content] of generatedFiles(contract)) if (stale.includes(path)) writeFileSync(resolve(root, path), content)
    process.stdout.write(check ? `Environment contract and generated files agree (${contract.variables.length} variables).\n` : `Generated files are up to date (${stale.length} rewritten).\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}
