import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { getCliOAuthConfiguration, getHostedEnvironment, HostedConfigurationError } from "../../src/lib/server/env"
import { root } from "./vite-ssr"
// @ts-expect-error plain ESM build script without type declarations
import * as contractLib from "../../scripts/env-contract.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { generatedFiles, staleFiles } from "../../scripts/generate-env-contract.mjs"

const { EXPOSURES, GROUPS, SENSITIVITIES, STORAGE_RANK, STORES, TARGETS, VALIDATOR_IDS, fixtureEnvironment, loadContract, missingOrInvalid, requiredNames, validateContract, vercelVariables } = contractLib
const contract = loadContract()
const schema = JSON.parse(readFileSync(resolve(root, "config/env.contract.schema.json"), "utf8"))
const RUNTIME_SHAPE_CHECKED = new Set(["WORKOS_REDIRECT_URI", "PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN"])
const clone = () => structuredClone(contract)

function problemsOf(candidate: unknown): string[] {
  try {
    validateContract(candidate)
    return []
  } catch (error) {
    return (error as { problems: string[] }).problems
  }
}

function runtimeMissing(source: Record<string, string | undefined>): string[] {
  const missing: string[] = []
  for (const read of [getHostedEnvironment, getCliOAuthConfiguration]) {
    try {
      read(source)
    } catch (error) {
      if (!(error instanceof HostedConfigurationError)) throw error
      missing.push(...error.missing)
    }
  }
  return missing
}

test("the committed contract is valid", () => {
  assert.ok(contract.variables.length > 0)
})

test("the editor schema and the loader agree on every enumerated value", () => {
  const defs = schema.$defs
  assert.deepEqual(defs.target.enum, TARGETS)
  assert.deepEqual(defs.storage.enum, Object.keys(STORAGE_RANK))
  assert.deepEqual(defs.validator.oneOf.map((option: any) => option.properties.id.const).sort(), [...VALIDATOR_IDS].sort())
  assert.deepEqual(defs.variable.properties.store.enum, STORES)
  assert.deepEqual(defs.variable.properties.sensitivity.enum, SENSITIVITIES)
  assert.deepEqual(defs.variable.properties.exposure.enum, EXPOSURES)
  assert.deepEqual(defs.variable.properties.group.enum, GROUPS)
  assert.deepEqual(defs.variable.required.sort(), Object.keys(defs.variable.properties).filter(key => key !== "githubEnvironments").sort())
})

test("the loader rejects malformed contracts, naming each problem", () => {
  const cases: [string, (candidate: any) => void, RegExp][] = [
    ["duplicate name", candidate => candidate.variables.push(structuredClone(candidate.variables[0])), /name is duplicated/],
    ["unknown field", candidate => { candidate.variables[0].extra = true }, /extra is not a known field/],
    ["missing field", candidate => { delete candidate.variables[0].owner }, /owner is required/],
    ["bad target", candidate => { candidate.variables[0].requiredIn = ["staging"] }, /requiredIn must be a list/],
    ["bad validator", candidate => { candidate.variables[0].validator = { id: "regex" } }, /validator.id must be one of/],
    ["minLength without min", candidate => { candidate.variables[0].validator = { id: "minLength" } }, /validator.min must be a positive integer/],
    ["required without fixture", candidate => { candidate.variables[0].ciFixture = null }, /needs a ciFixture/],
    ["fixture fails its validator", candidate => { candidate.variables.find((v: any) => v.validator.id === "minLength").ciFixture = "ci-fixture-short" }, /does not pass its own validator/],
    ["real-looking secret fixture", candidate => { candidate.variables.find((v: any) => v.sensitivity === "secret").ciFixture = "sk_live_abcdef" }, /must be obviously fake/],
    ["github-environment in a Vercel target", candidate => candidate.variables.push({ ...structuredClone(candidate.variables[0]), name: "RELEASE_ONLY", store: "github-environment", exposure: "ci", group: "release", ciFixture: null, githubEnvironments: ["release"] }), /requiredIn must be \[\]/],
    ["github-environment without environments", candidate => candidate.variables.push({ ...structuredClone(candidate.variables[0]), name: "RELEASE_ONLY", store: "github-environment", exposure: "ci", group: "release", ciFixture: null, requiredIn: [] }), /need githubEnvironments/],
    ["bad storage policy", candidate => { candidate.storagePolicy.secret.production = "hidden" }, /storagePolicy.secret.production must be one of/],
  ]
  for (const [label, mutate, expected] of cases) {
    const candidate = clone()
    mutate(candidate)
    const problems = problemsOf(candidate)
    assert.ok(problems.some(problem => expected.test(problem)), `${label}: ${problems.join("; ")}`)
  }
})

test("guard, runtime, .env.example and contract require exactly the same production names", () => {
  const contractNames = requiredNames(contract, "production").sort()
  const guard = spawnSync(process.execPath, [resolve(root, "scripts/check-hosted-env.mjs")], { env: { PATH: process.env.PATH ?? "", VERCEL_ENV: "production" }, encoding: "utf8" })
  assert.equal(guard.status, 1)
  const guardNames = [...guard.stderr.matchAll(/^ {2}- ([A-Z0-9_]+)$/gm)].map(match => match[1]).sort()
  const example = readFileSync(resolve(root, ".env.example"), "utf8")
  const exampleNames = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(match => match[1]).sort()
  assert.deepEqual(guardNames, contractNames)
  assert.deepEqual(runtimeMissing({}).sort(), contractNames)
  assert.deepEqual(exampleNames, vercelVariables(contract).map((variable: any) => variable.name).sort())
})

test("runtime validation and the build guard's validators agree value by value", () => {
  const values = [undefined, "", "   ", " , ", "x", "a,b", "ci-fixture-".padEnd(31, "x"), "ci-fixture-".padEnd(32, "x")]
  const base = fixtureEnvironment(contract)
  assert.deepEqual(missingOrInvalid(contract, base), [])
  assert.deepEqual(runtimeMissing(base), [])
  for (const variable of vercelVariables(contract)) {
    for (const value of values) {
      const source = { ...base, [variable.name]: value }
      const label = `${variable.name}=${JSON.stringify(value)}`
      const guard = missingOrInvalid(contract, source)
      const runtime = runtimeMissing(source)
      // The runtime also checks URL shapes the build guard does not (documented in docs/hosting.md),
      // so for those two names the runtime may reject more; it must never accept what the guard rejects.
      if (RUNTIME_SHAPE_CHECKED.has(variable.name)) for (const name of guard) assert.ok(runtime.includes(name), label)
      else assert.deepEqual(runtime, guard, label)
    }
  }
})

test("generated files are current and generation is deterministic", () => {
  const first = generatedFiles(contract)
  assert.deepEqual(generatedFiles(clone()), first)
  for (const [path, content] of first) assert.equal(readFileSync(resolve(root, path), "utf8"), content, `${path} is stale; run pnpm contract:generate`)
  assert.deepEqual(first.map(([path]: [string]) => path), ["src/lib/server/env.contract.ts", "src/env.ts", ".env.example", "docs/hosting.md"])
})

test("contract:check reports exactly the stale generated files", () => {
  const changed = clone()
  changed.variables[0].description = "Changed description"
  const committed = (path: string) => readFileSync(resolve(root, path), "utf8")
  assert.deepEqual(staleFiles(contract, committed), [])
  assert.deepEqual(staleFiles(changed, committed), ["docs/hosting.md"])
  changed.variables.push({ ...structuredClone(changed.variables[0]), name: "PLAN_MANAGER_NEW_SETTING" })
  assert.deepEqual(staleFiles(changed, committed), ["src/lib/server/env.contract.ts", "src/env.ts", ".env.example", "docs/hosting.md"])
  const check = spawnSync(process.execPath, [resolve(root, "scripts/generate-env-contract.mjs"), "--check"], { encoding: "utf8" })
  assert.equal(check.status, 0, check.stderr)
})

test("the client bundle check fails on any secret name or secret fixture value", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"))
  try {
    for (const variable of contract.variables.filter((v: any) => v.sensitivity === "secret")) {
      for (const needle of [variable.name, variable.ciFixture].filter(value => typeof value === "string")) {
        writeFileSync(join(dir, "app.js"), `console.log(${JSON.stringify(needle)})`)
        const result = spawnSync(process.execPath, [resolve(root, "scripts/check-client-bundle.mjs"), dir], { encoding: "utf8" })
        assert.equal(result.status, 1, `${variable.name}: ${result.stdout}`)
      }
    }
    writeFileSync(join(dir, "app.js"), "console.log('clean')")
    assert.equal(spawnSync(process.execPath, [resolve(root, "scripts/check-client-bundle.mjs"), dir]).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
