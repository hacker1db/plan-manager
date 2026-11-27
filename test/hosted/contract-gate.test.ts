import assert from "node:assert/strict"
import { test } from "node:test"
// @ts-expect-error plain ESM build script without type declarations
import { loadContract } from "../../scripts/env-contract.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { ownerApproval, requirementChanges, runGate, STATUS_CONTEXT } from "../../scripts/ci/contract-gate.mjs"

const base = loadContract()
const OWNER = "hacker1db"
const SHA = "0123456789abcdef0123456789abcdef01234567"

function withNewProductionVariable() {
  const head = structuredClone(base)
  head.variables.push({ ...structuredClone(head.variables[0]), name: "PLAN_MANAGER_NEW_SECRET", sensitivity: "secret", ciFixture: "ci-fixture-new-secret" })
  return head
}

const status = (login: string, state: string, created: string, context = STATUS_CONTEXT) => ({ context, state, created_at: created, creator: { login } })

async function gate(head: unknown, statuses: unknown[], baseContract: unknown = base) {
  const calls: string[] = []
  const lines: string[] = []
  const code = await runGate({ base: baseContract, head, owner: OWNER, headSha: SHA, listStatuses: async (sha: string) => { calls.push(sha); return statuses }, log: (line: string) => lines.push(line) })
  return { code, calls, output: lines.join("\n") }
}

test("an unchanged contract passes without asking GitHub for statuses", async () => {
  const result = await gate(structuredClone(base), [])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
})

test("description-only edits and removals are not provisioning changes", () => {
  const head = structuredClone(base)
  head.variables[0].description = "Edited"
  head.variables.pop()
  assert.deepEqual(requirementChanges(base, head), [])
})

test("a new production variable fails until the owner sets a success status on the head commit", async () => {
  const head = withNewProductionVariable()
  const blocked = await gate(head, [])
  assert.equal(blocked.code, 1)
  assert.deepEqual(blocked.calls, [SHA])
  assert.match(blocked.output, /PLAN_MANAGER_NEW_SECRET: new variable required in Vercel production/)
  assert.match(blocked.output, new RegExp(`statuses/${SHA} -f state=success -f context=${STATUS_CONTEXT}`))
  assert.equal((await gate(head, [status(OWNER, "success", "2026-11-26T10:00:00Z")])).code, 0)
})

test("statuses from anyone but the owner, including the agent identity, are ignored", async () => {
  const result = await gate(withNewProductionVariable(), [status("hacker1dbai", "success", "2026-11-26T10:00:00Z"), status("someone", "success", "2026-11-26T11:00:00Z")])
  assert.equal(result.code, 1)
  assert.match(result.output, /Ignored 2/)
})

test("the owner's latest status wins and other contexts do not count", () => {
  assert.equal(ownerApproval([status(OWNER, "success", "2026-11-26T10:00:00Z"), status(OWNER, "failure", "2026-11-26T11:00:00Z")], OWNER).approved, false)
  assert.equal(ownerApproval([status(OWNER, "failure", "2026-11-26T10:00:00Z"), status(OWNER, "success", "2026-11-26T11:00:00Z")], OWNER).approved, true)
  assert.equal(ownerApproval([status(OWNER, "success", "2026-11-26T10:00:00Z", "ci-required")], OWNER).approved, false)
  assert.equal(ownerApproval([status("HACKER1DB", "success", "2026-11-26T10:00:00Z")], OWNER).approved, true)
})

test("a changed build check, a newly production-required name, and a new GitHub environment secret all trip the gate", () => {
  const head = structuredClone(base)
  head.variables.find((variable: any) => variable.validator.id === "minLength").validator.min = 48
  const optional = structuredClone(head.variables[1])
  head.variables.push({ ...optional, name: "PLAN_MANAGER_OPTIONAL", requiredIn: ["preview"] })
  const baseWithOptional = structuredClone(base)
  baseWithOptional.variables.push({ ...optional, name: "PLAN_MANAGER_OPTIONAL", requiredIn: ["preview"] })
  head.variables.find((variable: any) => variable.name === "PLAN_MANAGER_OPTIONAL").requiredIn = ["preview", "production"]
  head.variables.push({ ...structuredClone(base.variables[0]), name: "VERCEL_TOKEN", store: "github-environment", requiredIn: [], exposure: "ci", group: "release", ciFixture: null, githubEnvironments: ["release"] })
  assert.deepEqual(requirementChanges(baseWithOptional, head).map((change: any) => `${change.name}: ${change.reason}`), [
    "WORKOS_COOKIE_PASSWORD: build check changed",
    "PLAN_MANAGER_OPTIONAL: now required in Vercel production",
    'VERCEL_TOKEN: newly required in GitHub environment "release"',
  ])
})

test("a base without a contract treats every production requirement as new", async () => {
  const result = await gate(structuredClone(base), [], { variables: [] })
  assert.equal(result.code, 1)
  for (const variable of base.variables) assert.match(result.output, new RegExp(`${variable.name}: (new variable required in Vercel production|newly required in GitHub environment)`))
})
