// Loads and validates config/env.contract.json, the single source for every environment variable
// NAME the hosted app, its build guard, the Vercel inventory checks and CI rely on. It never reads,
// requests or prints a value; validateValue() only answers valid/invalid for a value the caller
// already holds in memory. config/env.contract.schema.json documents the same rules for editors.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const CONTRACT_PATH = 'config/env.contract.json'
export const TARGETS = ['production', 'preview', 'development']
export const STORAGE_RANK = { plain: 0, encrypted: 1, sensitive: 2 }
export const VALIDATOR_IDS = ['nonEmpty', 'csvNonEmpty', 'minLength']
export const STORES = ['vercel', 'github-environment']
export const SENSITIVITIES = ['secret', 'config']
export const EXPOSURES = ['server', 'ci']
export const GROUPS = ['hosted', 'cli', 'release']
const VARIABLE_FIELDS = ['name', 'store', 'requiredIn', 'githubEnvironments', 'sensitivity', 'exposure', 'group', 'validator', 'ciFixture', 'owner', 'docs', 'description']
const REQUIRED_FIELDS = VARIABLE_FIELDS.filter(field => field !== 'githubEnvironments')

export class ContractError extends Error {
  constructor(problems) {
    super(`Invalid ${CONTRACT_PATH}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'ContractError'
    this.problems = problems
  }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0

function checkStorageByTarget(value, where, problems) {
  if (!isObject(value)) return problems.push(`${where} must be an object`)
  for (const key of Object.keys(value)) if (!TARGETS.includes(key)) problems.push(`${where}.${key} is not a target`)
  for (const target of TARGETS) if (!(value[target] in STORAGE_RANK)) problems.push(`${where}.${target} must be one of ${Object.keys(STORAGE_RANK).join(', ')}`)
}

function checkValidator(validator, where, problems) {
  if (!isObject(validator) || !VALIDATOR_IDS.includes(validator.id)) return problems.push(`${where}.validator.id must be one of ${VALIDATOR_IDS.join(', ')}`)
  const allowed = validator.id === 'minLength' ? ['id', 'min'] : ['id']
  for (const key of Object.keys(validator)) if (!allowed.includes(key)) problems.push(`${where}.validator.${key} is not allowed for ${validator.id}`)
  if (validator.id === 'minLength' && !(Number.isInteger(validator.min) && validator.min >= 1)) problems.push(`${where}.validator.min must be a positive integer`)
}

// Structural validation equivalent to config/env.contract.schema.json, plus cross-field rules a
// JSON Schema cannot express cleanly. Throws ContractError listing every problem.
export function validateContract(contract) {
  const problems = []
  if (!isObject(contract)) throw new ContractError(['contract must be an object'])
  for (const key of Object.keys(contract)) if (!['$schema', 'version', 'storagePolicy', 'variables'].includes(key)) problems.push(`unknown top-level field ${key}`)
  if (contract.version !== 1) problems.push('version must be 1')
  if (!isObject(contract.storagePolicy)) problems.push('storagePolicy must be an object')
  else {
    for (const key of Object.keys(contract.storagePolicy)) if (!SENSITIVITIES.includes(key)) problems.push(`storagePolicy.${key} is not a sensitivity`)
    for (const sensitivity of SENSITIVITIES) checkStorageByTarget(contract.storagePolicy[sensitivity], `storagePolicy.${sensitivity}`, problems)
  }
  if (!Array.isArray(contract.variables) || contract.variables.length === 0) problems.push('variables must be a non-empty array')
  const seen = new Set()
  for (const [index, variable] of (Array.isArray(contract.variables) ? contract.variables : []).entries()) {
    const where = `variables[${index}]${nonEmptyString(variable?.name) ? ` (${variable.name})` : ''}`
    if (!isObject(variable)) { problems.push(`${where} must be an object`); continue }
    for (const key of Object.keys(variable)) if (!VARIABLE_FIELDS.includes(key)) problems.push(`${where}.${key} is not a known field`)
    for (const key of REQUIRED_FIELDS) if (!(key in variable)) problems.push(`${where}.${key} is required`)
    if (typeof variable.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(variable.name)) problems.push(`${where}.name must match ^[A-Z][A-Z0-9_]*$`)
    else if (seen.has(variable.name)) problems.push(`${where}.name is duplicated`)
    else seen.add(variable.name)
    if (!STORES.includes(variable.store)) problems.push(`${where}.store must be one of ${STORES.join(', ')}`)
    if (!Array.isArray(variable.requiredIn) || variable.requiredIn.some(target => !TARGETS.includes(target)) || new Set(variable.requiredIn).size !== variable.requiredIn.length) {
      problems.push(`${where}.requiredIn must be a list of distinct targets from ${TARGETS.join(', ')}`)
    }
    if ('githubEnvironments' in variable && (!Array.isArray(variable.githubEnvironments) || variable.githubEnvironments.length === 0 || !variable.githubEnvironments.every(nonEmptyString) || new Set(variable.githubEnvironments).size !== variable.githubEnvironments.length)) {
      problems.push(`${where}.githubEnvironments must be a non-empty list of distinct environment names`)
    }
    if (!SENSITIVITIES.includes(variable.sensitivity)) problems.push(`${where}.sensitivity must be one of ${SENSITIVITIES.join(', ')}`)
    if (!EXPOSURES.includes(variable.exposure)) problems.push(`${where}.exposure must be one of ${EXPOSURES.join(', ')}`)
    if (!GROUPS.includes(variable.group)) problems.push(`${where}.group must be one of ${GROUPS.join(', ')}`)
    checkValidator(variable.validator, where, problems)
    if (variable.ciFixture !== null && typeof variable.ciFixture !== 'string') problems.push(`${where}.ciFixture must be a string or null`)
    for (const key of ['owner', 'docs', 'description']) if (!nonEmptyString(variable[key])) problems.push(`${where}.${key} must be a non-empty string`)
    // Cross-field rules.
    if (variable.store === 'vercel') {
      if (variable.exposure !== 'server') problems.push(`${where}: Vercel variables must have exposure "server"`)
      if (Array.isArray(variable.requiredIn) && variable.requiredIn.length > 0 && typeof variable.ciFixture !== 'string') problems.push(`${where}: a required Vercel variable needs a ciFixture`)
      if (typeof variable.ciFixture === 'string' && isObject(variable.validator) && VALIDATOR_IDS.includes(variable.validator.id) && !validateValue(variable.validator, variable.ciFixture)) problems.push(`${where}: ciFixture does not pass its own validator`)
      if (variable.group === 'release') problems.push(`${where}: group "release" is only for github-environment variables`)
    }
    if (variable.store === 'github-environment') {
      if (Array.isArray(variable.requiredIn) && variable.requiredIn.length > 0) problems.push(`${where}: github-environment variables are not in Vercel, so requiredIn must be []`)
      if (!('githubEnvironments' in variable)) problems.push(`${where}: github-environment variables need githubEnvironments`)
      if (variable.exposure !== 'ci') problems.push(`${where}: github-environment variables must have exposure "ci"`)
      if (variable.ciFixture !== null) problems.push(`${where}: github-environment variables are never given to PR CI, so ciFixture must be null`)
    }
    if (typeof variable.ciFixture === 'string' && variable.sensitivity === 'secret' && !/ci-fixture|\.invalid\b/.test(variable.ciFixture)) problems.push(`${where}: secret fixtures must be obviously fake (contain "ci-fixture" or a .invalid host)`)
  }
  if (problems.length > 0) throw new ContractError(problems)
  return contract
}

export function loadContract(path = resolve(root, CONTRACT_PATH)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ContractError([`could not read ${CONTRACT_PATH}: ${error.message}`])
  }
  return validateContract(parsed)
}

// True when the value satisfies the validator. Callers must never print the value.
export function validateValue(validator, value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  switch (validator.id) {
    case 'nonEmpty': return true
    case 'csvNonEmpty': return value.split(',').some(item => item.trim() !== '')
    case 'minLength': return value.length >= validator.min
    default: return false
  }
}

export const vercelVariables = contract => contract.variables.filter(variable => variable.store === 'vercel')
export const requiredIn = (contract, target) => vercelVariables(contract).filter(variable => variable.requiredIn.includes(target))
export const requiredNames = (contract, target) => requiredIn(contract, target).map(variable => variable.name)

// Names of production-required variables that are missing or invalid in `source`, in contract order.
export function missingOrInvalid(contract, source, target = 'production') {
  return requiredIn(contract, target).filter(variable => !validateValue(variable.validator, source[variable.name])).map(variable => variable.name)
}

export function minimumStorage(contract, variable, target) {
  return contract.storagePolicy[variable.sensitivity][target]
}

export function describeValidator(validator) {
  return validator.id === 'minLength' ? `at least ${validator.min} characters` : validator.id === 'csvNonEmpty' ? 'comma-separated, at least one item' : 'non-empty'
}

// Environment for a VERCEL_ENV=production build with obviously fake fixtures for every variable.
export function fixtureEnvironment(contract) {
  return Object.fromEntries(vercelVariables(contract).filter(variable => typeof variable.ciFixture === 'string').map(variable => [variable.name, variable.ciFixture]))
}
