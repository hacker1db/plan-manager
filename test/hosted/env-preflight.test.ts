import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { root } from "./vite-ssr"
// @ts-expect-error plain ESM build script without type declarations
import { loadContract, requiredNames } from "../../scripts/env-contract.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { auditConfiguration, renderReport, runPreflight } from "../../scripts/ci/env-drift.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { createVercelClient, envMetadata } from "../../scripts/ci/vercel-client.mjs"

const contract = loadContract()
const recording = JSON.parse(readFileSync(resolve(root, "test/fixtures/vercel-drift-recording.json"), "utf8"))
const PROD_ENV = "GET /v10/projects/prj_production/env"
const OWNER = "PLAN_MANAGER_OWNER_WORKOS_USER_IDS"

function clientFor(envs: unknown[], status = 200) {
  return createVercelClient({ token: "fake", fetchImpl: async () => new Response(status === 200 ? JSON.stringify({ envs }) : "{}", { status }) })
}

const productionWithout = (name: string) => recording[PROD_ENV].envs.filter((record: any) => record.key !== name)

function runScript(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [resolve(root, "scripts/ci/env-drift.mjs"), ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test("#104 class: an unchanged contract with Production missing the owner list fails preflight naming only that key", async () => {
  const missing = await runPreflight(clientFor(productionWithout(OWNER)), { contract, productionId: "prj_production" })
  assert.deepEqual(missing.map((problem: any) => problem.name), [OWNER])
  const dir = mkdtempSync(join(tmpdir(), "preflight-"))
  try {
    const file = join(dir, "recording.json")
    writeFileSync(file, JSON.stringify({ ...recording, [PROD_ENV]: { envs: productionWithout(OWNER) } }))
    const { status, output } = runScript(["--preflight", "--recording", file])
    assert.equal(status, 1)
    assert.deepEqual([...output.matchAll(/^ {2}- ([A-Z0-9_]+)$/gm)].map(match => match[1]), [OWNER])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("records with no target, a string target, a branch scope, or only a custom environment do not count as Production", async () => {
  const weird = (target: unknown, extra: Record<string, unknown> = {}) => [...productionWithout(OWNER), { key: OWNER, type: "encrypted", ...(target === undefined ? {} : { target }), ...extra }]
  const cases: [string, unknown[]][] = [
    ["target absent", weird(undefined)],
    ["target empty", weird([])],
    ["target null", weird(null)],
    ["string preview target", weird("preview")],
    ["branch-scoped production", weird(["production"], { gitBranch: "feature/x" })],
    ["custom environment only", weird([], { customEnvironmentIds: ["env_staging"] })],
    ["non-string target entries", weird([null, 7])],
  ]
  for (const [label, envs] of cases) {
    const missing = await runPreflight(clientFor(envs), { contract, productionId: "prj_production" })
    assert.deepEqual(missing.map((problem: any) => problem.name), [OWNER], label)
  }
  assert.deepEqual(await runPreflight(clientFor(weird("production")), { contract, productionId: "prj_production" }), [], "a string 'production' target is normalized and counts")
  assert.deepEqual(envMetadata({ key: "A", target: "production", gitBranch: "", value: "x" }), { key: "A", target: ["production"], type: "", id: "", gitBranch: null, customEnvironmentIds: [] })
})

test("preflight fails closed on HTTP 401, HTTP 5xx, a missing project ID, and a missing token", async () => {
  for (const status of [401, 403, 500, 503]) await assert.rejects(runPreflight(clientFor([], status), { contract, productionId: "prj_production" }), new RegExp(`HTTP ${status}`))
  await assert.rejects(runPreflight(clientFor([]), { contract, productionId: "" }), /VERCEL_PROJECT_ID_PRODUCTION/)
  const noToken = runScript(["--preflight"], { VERCEL_PROJECT_ID_PRODUCTION: "prj_production" })
  assert.equal(noToken.status, 1)
  assert.match(noToken.output, /failed closed: VERCEL_TOKEN is not set/)
  const noProject = runScript(["--preflight"], { VERCEL_TOKEN: "unused" })
  assert.equal(noProject.status, 1)
  assert.match(noProject.output, /failed closed/)
})

test("an empty Production target fails preflight naming every production-required name", async () => {
  const missing = await runPreflight(clientFor([]), { contract, productionId: "prj_production" })
  assert.deepEqual(missing.map((problem: any) => problem.name).sort(), requiredNames(contract, "production").sort())
})

test("the full report lists missing names first and caps historical deployment noise", () => {
  const deployments = Array.from({ length: 30 }, (_, index) => ({ uid: `dpl_${index}`, target: null, createdAt: 1, meta: {} }))
  const problems = auditConfiguration({ contract, production: { env: productionWithout(OWNER).map(envMetadata), project: { link: { type: "github" } }, deployments }, preview: { env: recording["GET /v10/projects/prj_preview/env"].envs.map(envMetadata) } })
  assert.deepEqual(problems.slice(0, 2).map((problem: any) => problem.check), ["missing", "git-connected"])
  assert.equal(problems[0].name, OWNER)
  const report = renderReport(problems)
  assert.match(report, /Summary: missing 1, git-connected 1, non-main-deployment 30\./)
  assert.ok(report.indexOf(OWNER) < report.indexOf("dpl_0"))
  assert.equal((report.match(/\| non-main-deployment \|/g) ?? []).length, 20)
  assert.match(report, /10 more non-main-deployment rows not shown/)
})
