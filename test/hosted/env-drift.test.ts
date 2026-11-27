import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import { root } from "./vite-ssr"
// @ts-expect-error plain ESM build script without type declarations
import { loadContract } from "../../scripts/env-contract.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { auditConfiguration, collect, githubProvenance, renderReport } from "../../scripts/ci/env-drift.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { createRecordedFetch, createVercelClient, envMetadata } from "../../scripts/ci/vercel-client.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { reconcileAlert } from "../../scripts/ci/alert-issue.mjs"
// @ts-expect-error plain ESM build script without type declarations
import { evaluate } from "../../scripts/ci/release-watchdog.mjs"

const contract = loadContract()
const recording = JSON.parse(readFileSync(resolve(root, "test/fixtures/vercel-drift-recording.json"), "utf8"))
const SHA = "1be8da5cc6135acef20e69b617499a13fbd8d307"
const LEAK = "must-never-appear-in-any-output"

async function recorded(overrides: Record<string, unknown> = {}) {
  const vercel = createVercelClient({ token: "fake", fetchImpl: createRecordedFetch({ ...structuredClone(recording), ...overrides }) })
  return collect(vercel, { productionId: "prj_production", previewId: "prj_preview", verifyProvenance: async () => ({ ok: true }) })
}

const checks = (problems: any[]) => problems.map(problem => `${problem.check}:${problem.project}:${problem.target ?? ""}:${problem.name ?? ""}`)

test("the recorded, compliant configuration has no drift", async () => {
  assert.deepEqual(auditConfiguration({ contract, ...(await recorded()) }), [])
})

test("environment listings keep metadata only; values are dropped before anything else sees them", async () => {
  assert.deepEqual(envMetadata({ key: "A", target: "production", type: "plain", value: LEAK, decrypted: true, id: "env_1" }), { key: "A", target: ["production"], type: "plain", id: "env_1", gitBranch: null, customEnvironmentIds: [] })
  const productionEnv = structuredClone(recording["GET /v10/projects/prj_production/env"])
  for (const record of productionEnv.envs) record.value = LEAK
  productionEnv.envs.find((record: any) => record.key === "WORKOS_API_KEY").type = "plain"
  const state = await recorded({ "GET /v10/projects/prj_production/env": productionEnv })
  assert.equal(JSON.stringify(state).includes(LEAK), false)
  const problems = auditConfiguration({ contract, ...state })
  assert.deepEqual(checks(problems), ["storage-type:production:production:WORKOS_API_KEY"])
  assert.equal(renderReport(problems).includes(LEAK), false)
})

test("a missing production variable, an encrypted preview secret, and a missing development name are each reported", async () => {
  const productionEnv = structuredClone(recording["GET /v10/projects/prj_production/env"])
  productionEnv.envs = productionEnv.envs.filter((record: any) => record.key !== "PLAN_MANAGER_WORKOS_CLI_AUDIENCE")
  const previewEnv = structuredClone(recording["GET /v10/projects/prj_preview/env"])
  previewEnv.envs.find((record: any) => record.key === "DATABASE_URL" && record.target.includes("preview")).type = "encrypted"
  previewEnv.envs = previewEnv.envs.filter((record: any) => !(record.key === "WORKOS_CLIENT_ID" && record.target.includes("development")))
  const problems = auditConfiguration({ contract, ...(await recorded({ "GET /v10/projects/prj_production/env": productionEnv, "GET /v10/projects/prj_preview/env": previewEnv })) })
  assert.deepEqual(checks(problems), [
    "missing:production:production:PLAN_MANAGER_WORKOS_CLI_AUDIENCE",
    "missing:preview:development:WORKOS_CLIENT_ID",
    "storage-type:preview:preview:DATABASE_URL",
  ])
})

test("development secrets accept encrypted, and the legacy secret type counts as encrypted", () => {
  const variable = contract.variables.find((v: any) => v.name === "DATABASE_URL")
  const base = { production: { env: [], project: {}, deployments: [] }, preview: { env: [] } }
  const only = (type: string) => auditConfiguration({ contract: { ...contract, variables: [variable] }, ...base, preview: { env: [{ key: variable.name, target: ["preview"], type: "sensitive" }, { key: variable.name, target: ["development"], type }] } }).filter((p: any) => p.target === "development")
  assert.deepEqual(only("encrypted"), [])
  assert.deepEqual(only("secret"), [])
  assert.deepEqual(checks(only("plain")), ["storage-type:preview:development:DATABASE_URL"])
})

test("isolation: production-target variables in the preview project and a Git-connected production project fail", async () => {
  const previewEnv = structuredClone(recording["GET /v10/projects/prj_preview/env"])
  previewEnv.envs.push({ key: "WORKOS_API_KEY", target: ["production"], type: "sensitive" }, { key: "VERCEL_URL", target: ["production"], type: "system" })
  const problems = auditConfiguration({ contract, ...(await recorded({ "GET /v10/projects/prj_preview/env": previewEnv, "GET /v9/projects/prj_production": { id: "prj_production", link: { type: "github", repo: "plan-manager" } } })) })
  assert.deepEqual(checks(problems), ["preview-production-target:preview:production:WORKOS_API_KEY", "git-connected:production::"])
})

test("isolation: any production-project deployment not created by release.yml from main fails", async () => {
  const deployments = [
    { uid: "dpl_release", target: "production", createdAt: 2_000, meta: { planManagerRef: "main", planManagerSha: SHA, planManagerRun: "42" } },
    { uid: "dpl_branch_preview", target: null, createdAt: 2_000, meta: { githubCommitRef: "feature/x" } },
    { uid: "dpl_forged_ref", target: "production", createdAt: 2_000, meta: { planManagerRef: "feature/x", planManagerSha: SHA } },
    { uid: "dpl_no_sha", target: "production", createdAt: 2_000, meta: { planManagerRef: "main" } },
    { uid: "dpl_before_cutover", target: null, createdAt: 500, meta: {} },
  ]
  const problems = auditConfiguration({ contract, ...(await recorded({ "GET /v6/deployments": { deployments } })), isolationSince: 1_000 })
  assert.deepEqual(problems.map((problem: any) => problem.detail.split(" ")[1]), ["dpl_branch_preview", "dpl_forged_ref", "dpl_no_sha"])
  assert.equal(auditConfiguration({ contract, ...(await recorded({ "GET /v6/deployments": { deployments } })) }).length, 4, "without a cut-over date every old deployment is flagged (fail closed)")
  const undated = auditConfiguration({ contract, production: { env: [], project: {}, deployments: [{ uid: "dpl_undated", target: "production", meta: {} }] }, preview: { env: [] } }).filter((p: any) => p.check === "non-main-deployment")
  assert.match(undated[0].detail, /dpl_undated has no creation time/)
})

test("isolation: release metadata is only trusted after GitHub confirms the run, the commit and the time window", async () => {
  const created = Date.parse("2026-11-26T10:05:00Z")
  const deployment = { uid: "dpl_x", target: "production", createdAt: created, meta: { planManagerRef: "main", planManagerSha: SHA, planManagerRun: "42" } }
  const goodRun = { path: ".github/workflows/release.yml", head_branch: "main", head_sha: SHA, repository: { full_name: "hacker1db/plan-manager" }, status: "completed", run_started_at: "2026-11-26T10:00:00Z", updated_at: "2026-11-26T10:10:00Z" }
  const github = (run: any, compare = "ahead") => ({ repository: "hacker1db/plan-manager", request: async (_method: string, path: string) => path.includes("/compare/") ? { status: compare } : run })
  assert.deepEqual(await githubProvenance(github(goodRun))(deployment), { ok: true })
  const cases: [string, any, string?, any?][] = [
    ["wrong workflow", { ...goodRun, path: ".github/workflows/ci.yml" }],
    ["wrong branch", { ...goodRun, head_branch: "feature/x" }],
    ["wrong commit", { ...goodRun, head_sha: "f".repeat(40) }],
    ["other repository", { ...goodRun, repository: { full_name: "fork/plan-manager" } }],
    ["created before the run", { ...goodRun, run_started_at: "2026-11-26T10:06:00Z" }],
    ["created long after the run", { ...goodRun, updated_at: "2026-11-26T09:00:00Z", run_started_at: "2026-11-26T08:00:00Z" }],
    ["commit not on main", goodRun, "diverged"],
    ["no run ID", goodRun, "ahead", { ...deployment, meta: { ...deployment.meta, planManagerRun: undefined } }],
  ]
  for (const [label, run, compare, target] of cases) assert.equal((await githubProvenance(github(run, compare))(target ?? deployment)).ok, false, label)
  const failing = { repository: "hacker1db/plan-manager", request: async () => { throw new Error("GitHub API failed with HTTP 404") } }
  assert.deepEqual(await githubProvenance(failing)(deployment), { ok: false, reason: "GitHub API failed with HTTP 404" })
  const problems = auditConfiguration({ contract, production: { env: [], project: {}, deployments: [{ ...deployment, provenance: { ok: false, reason: "run 42 is not a release.yml run" } }] }, preview: { env: [] } }).filter((p: any) => p.check === "non-main-deployment")
  assert.match(problems[0].detail, /could not be verified: run 42/)
})

test("the Vercel client reads every page of deployments and fails closed on too many", async () => {
  const pages: Record<string, any> = { "": { deployments: [{ uid: "a" }], pagination: { next: 300 } }, "300": { deployments: [{ uid: "b" }], pagination: { next: 200 } }, "200": { deployments: [{ uid: "c" }], pagination: { next: null } } }
  const fetchImpl = async (url: URL) => new Response(JSON.stringify(pages[url.searchParams.get("until") ?? ""]), { status: 200 })
  const client = createVercelClient({ token: "t", fetchImpl })
  assert.deepEqual((await client.listDeployments("prj")).map((d: any) => d.uid), ["a", "b", "c"])
  await assert.rejects(client.listDeployments("prj", { maxPages: 2 }), /more than 200 deployments/)
})

test("the Vercel client sends the team only when configured and fails on HTTP errors", async () => {
  const urls: string[] = []
  const fetchImpl = async (url: URL) => { urls.push(url.toString()); return new Response("{}", { status: url.pathname.includes("missing") ? 404 : 200 }) }
  await createVercelClient({ token: "t", fetchImpl }).getProject("prj_a")
  await createVercelClient({ token: "t", teamId: "team_1", fetchImpl }).getProject("prj_a")
  assert.deepEqual(urls, ["https://api.vercel.com/v9/projects/prj_a", "https://api.vercel.com/v9/projects/prj_a?teamId=team_1"])
  await assert.rejects(createVercelClient({ token: "t", fetchImpl }).getProject("missing"), /HTTP 404/)
  assert.throws(() => createVercelClient({ token: "" }), /VERCEL_TOKEN/)
})

function fakeGitHub(openIssues: any[]) {
  const calls: string[] = []
  return {
    calls,
    request: async (method: string, path: string, body?: any) => {
      calls.push(`${method} ${path.split("?")[0]}${body?.state ? ` state=${body.state}` : ""}`)
      return method === "GET" ? openIssues : {}
    },
  }
}

test("alerts are deduplicated: create once, then update; close when resolved", async () => {
  const title = "Alert: Vercel configuration drift"
  const none = fakeGitHub([])
  assert.equal(await reconcileAlert(none, { title, failing: true, body: "x" }), "created")
  assert.deepEqual(none.calls, ["GET /repos/{repo}/issues", "POST /repos/{repo}/issues"])
  const existing = fakeGitHub([{ number: 7, title: "Other" }, { number: 9, title, pull_request: {} }, { number: 8, title }])
  assert.equal(await reconcileAlert(existing, { title, failing: true, body: "x" }), "updated")
  assert.deepEqual(existing.calls.slice(1), ["PATCH /repos/{repo}/issues/8"])
  const resolved = fakeGitHub([{ number: 8, title }])
  assert.equal(await reconcileAlert(resolved, { title, failing: false, body: "" }), "closed")
  assert.deepEqual(resolved.calls.slice(1), ["POST /repos/{repo}/issues/8/comments", "PATCH /repos/{repo}/issues/8 state=closed"])
  assert.equal(await reconcileAlert(fakeGitHub([]), { title, failing: false, body: "" }), "none")
})

const MIN = 60_000
const NOW = Date.parse("2026-11-26T12:00:00Z")
const run = (fields: any) => ({ id: 1, run_number: 1, head_sha: SHA, status: "completed", conclusion: "success", ...fields })

test("watchdog: waiting for approval never alarms; the clock starts when the release job starts", () => {
  const base = { headSha: SHA, ciRun: null, waiting: [], now: NOW }
  assert.deepEqual(evaluate({ ...base, runs: [run({ status: "waiting", conclusion: null })], releaseJob: null, waiting: [run({ status: "waiting" })] }), [])
  assert.deepEqual(evaluate({ ...base, runs: [run({ status: "in_progress", conclusion: null })], releaseJob: { started_at: new Date(NOW - 59 * MIN).toISOString() } }), [])
  assert.match(evaluate({ ...base, runs: [run({ status: "in_progress", conclusion: null })], releaseJob: { started_at: new Date(NOW - 61 * MIN).toISOString() } })[0], /approved 61 minutes ago/)
  assert.deepEqual(evaluate({ ...base, runs: [run({})], releaseJob: null }), [])
  assert.match(evaluate({ ...base, runs: [run({ conclusion: "failure" })], releaseJob: null })[0], /ended "failure"/)
})

test("watchdog: a release that never started after green CI, and superseded runs holding the lock, alarm", () => {
  const ciRun = { status: "completed", conclusion: "success", updated_at: new Date(NOW - 31 * MIN).toISOString() }
  assert.match(evaluate({ headSha: SHA, ciRun, runs: [], releaseJob: null, waiting: [], now: NOW })[0], /no release run started/)
  assert.deepEqual(evaluate({ headSha: SHA, ciRun: { ...ciRun, updated_at: new Date(NOW - 5 * MIN).toISOString() }, runs: [], releaseJob: null, waiting: [], now: NOW }), [])
  const stale = run({ id: 2, head_sha: "f".repeat(40), status: "waiting" })
  assert.match(evaluate({ headSha: SHA, ciRun: null, runs: [run({})], releaseJob: null, waiting: [stale], now: NOW })[0], /superseded commit ffffffffffff .* holds the release lock/)
})
