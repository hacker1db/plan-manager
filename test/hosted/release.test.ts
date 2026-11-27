import assert from "node:assert/strict"
import { test } from "node:test"
// @ts-expect-error plain ESM build script without type declarations
import { cancelSupersededRuns, httpProbe, release } from "../../scripts/ci/release.mjs"

const SHA = "a".repeat(40)
const PROJECT = "prj_production"
const DOMAIN = "planmanager.example.com"
const NEW = "dpl_new"
const PREV = "dpl_prev"
const BYPASS = "fake-bypass"
const DETAIL = "fake-detail-token"

type Options = {
  readyStates?: string[]
  promoteJob?: string[]
  rollbackJob?: string[]
  rollbackThrows?: boolean
  domainLag?: number
  liveHealthy?: boolean
  stagedHealthy?: boolean
  heads?: string[]
  externalPromotionAt?: "before-promote" | "after-promote"
  deployment?: Record<string, unknown>
}

// Stateful fake of the parts of Vercel the release touches. Alias jobs progress one state per poll.
function fakeVercel(options: Options = {}) {
  const mutations: string[] = []
  const readyStates = [...(options.readyStates ?? ["BUILDING", "READY"])]
  let production = PREV
  let job: { toDeploymentId: string; jobStatus: string; states: string[] } | null = null
  let projectReads = 0
  let domainLag = options.domainLag ?? 0
  const advance = () => {
    if (!job) return
    if (job.states.length) job.jobStatus = job.states.shift()!
    if (job.jobStatus === "succeeded") production = job.toDeploymentId
  }
  return {
    mutations,
    get production() { return production },
    async getDeployment(idOrUrl: string) {
      if (idOrUrl === DOMAIN) {
        if (domainLag > 0) { domainLag--; return { id: PREV } }
        return { id: production }
      }
      const state = readyStates.length > 1 ? readyStates.shift()! : readyStates[0]
      return { id: NEW, url: "plan-manager-abc.vercel.app", projectId: PROJECT, target: "production", readyState: state, meta: { planManagerSha: SHA }, ...options.deployment }
    },
    async getProject() {
      projectReads++
      if (options.externalPromotionAt === "before-promote" && projectReads === 2) production = "dpl_someone_else"
      advance()
      return { id: PROJECT, targets: { production: { id: production } }, lastAliasRequest: job && { toDeploymentId: job.toDeploymentId, jobStatus: job.jobStatus } }
    },
    async promote(_project: string, id: string) {
      mutations.push(`promote ${id}`)
      job = { toDeploymentId: id, jobStatus: "pending", states: [...(options.promoteJob ?? ["in-progress", "succeeded"])] }
      if (options.externalPromotionAt === "after-promote") { job = null; production = "dpl_someone_else" }
    },
    async rollback(_project: string, id: string) {
      mutations.push(`rollback ${id}`)
      if (options.rollbackThrows) throw new Error("Vercel API POST /v1/projects/prj_production/rollback/dpl_prev failed with HTTP 500")
      job = { toDeploymentId: id, jobStatus: "pending", states: [...(options.rollbackJob ?? ["in-progress", "in-progress", "succeeded"])] }
    },
  }
}

function fakeProbe(options: Options, calls: { url: string; headers: Record<string, string> }[]) {
  return async (url: string, { headers }: { headers: Record<string, string> }) => {
    calls.push({ url, headers })
    const staged = !url.includes(DOMAIN)
    const healthy = staged ? options.stagedHealthy ?? true : options.liveHealthy ?? true
    if (url.endsWith("/api/health")) return { status: 200, json: { status: "ok" } }
    if (url.endsWith("/api/health/detail")) {
      if (headers.authorization !== `Bearer ${DETAIL}`) return { status: 401, json: null }
      return healthy ? { status: 200, json: { status: "ok", checks: { database: true } } } : { status: 503, json: { status: "degraded", checks: { database: false } } }
    }
    return { status: 401, json: null }
  }
}

async function run(options: Options = {}) {
  const vercel = fakeVercel(options)
  const heads = [...(options.heads ?? [SHA])]
  const probes: { url: string; headers: Record<string, string> }[] = []
  let clock = 0
  let outcome: string
  let message = ""
  try {
    outcome = (await release({
      vercel,
      mainHead: async () => (heads.length > 1 ? heads.shift() : heads[0]),
      probe: fakeProbe(options, probes),
      log: () => {},
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      config: { projectId: PROJECT, sha: SHA, deploymentUrl: "plan-manager-abc.vercel.app", productionDomain: DOMAIN, bypass: BYPASS, detailToken: DETAIL, pollIntervalMs: 1_000, readyTimeoutMs: 20_000, aliasTimeoutMs: 20_000 },
    })).outcome
  } catch (error: any) {
    outcome = error.outcome ?? "error"
    message = error.message
  }
  return { outcome, message, mutations: vercel.mutations, production: vercel.production, probes, clock }
}

test("happy path: one promote, production serves the new deployment, staged probes carry the bypass and live probes do not", async () => {
  const result = await run()
  assert.equal(result.outcome, "released")
  assert.deepEqual(result.mutations, [`promote ${NEW}`])
  assert.equal(result.production, NEW)
  const staged = result.probes.filter(probe => !probe.url.includes(DOMAIN))
  const live = result.probes.filter(probe => probe.url.includes(DOMAIN))
  assert.equal(staged.length, 4)
  assert.ok(staged.every(probe => probe.headers["x-vercel-protection-bypass"] === BYPASS))
  assert.ok(live.length > 0 && live.every(probe => !("x-vercel-protection-bypass" in probe.headers)))
})

test("a superseded commit makes no Vercel calls that mutate", async () => {
  assert.deepEqual(await run({ heads: ["b".repeat(40)] }).then(r => [r.outcome, r.mutations]), ["superseded", []])
})

test("a deployment that ends in ERROR fails fast without waiting for the timeout", async () => {
  const result = await run({ readyStates: ["BUILDING", "ERROR"] })
  assert.equal(result.outcome, "deploy-failed")
  assert.ok(result.clock <= 1_000, `waited ${result.clock}ms`)
  assert.deepEqual(result.mutations, [])
})

test("a deployment that never becomes READY times out with no mutation", async () => {
  const result = await run({ readyStates: ["BUILDING"] })
  assert.match(result.message, /timed out waiting for the deployment/)
  assert.deepEqual(result.mutations, [])
})

test("a deployment from another project or commit is rejected", async () => {
  for (const deployment of [{ projectId: "prj_preview" }, { target: null }, { meta: { planManagerSha: "c".repeat(40) } }]) {
    const result = await run({ deployment })
    assert.equal(result.outcome, "wrong-deployment")
    assert.deepEqual(result.mutations, [])
  }
})

test("failed staged checks stop the release before any mutation", async () => {
  const result = await run({ stagedHealthy: false })
  assert.equal(result.outcome, "staged-checks-failed")
  assert.match(result.message, /database failing/)
  assert.deepEqual(result.mutations, [])
})

test("stale guard: main moved during staged checks, so nothing is promoted", async () => {
  const result = await run({ heads: [SHA, "b".repeat(40)] })
  assert.equal(result.outcome, "superseded")
  assert.deepEqual(result.mutations, [])
})

test("stale guard: an external promotion between recording PREV and promoting aborts with zero mutations", async () => {
  const result = await run({ externalPromotionAt: "before-promote" })
  assert.equal(result.outcome, "external-promotion")
  assert.deepEqual(result.mutations, [])
})

test("failed production smoke rolls back to the exact PREV ID, waits for the async alias job, and checks the domain", async () => {
  const result = await run({ liveHealthy: false })
  assert.equal(result.outcome, "rolled-back")
  assert.deepEqual(result.mutations, [`promote ${NEW}`, `rollback ${PREV}`])
  assert.equal(result.production, PREV)
  assert.ok(result.clock >= 2_000, "polled the rollback job through pending and in-progress")
})

test("a domain that still serves the old deployment after promote counts as failure and rolls back", async () => {
  const result = await run({ domainLag: 1 })
  assert.equal(result.outcome, "rolled-back")
  assert.deepEqual(result.mutations, [`promote ${NEW}`, `rollback ${PREV}`])
})

test("a failed promote alias job leaves PREV serving and does not roll back", async () => {
  const result = await run({ promoteJob: ["in-progress", "failed"] })
  assert.equal(result.outcome, "promote-failed")
  assert.deepEqual(result.mutations, [`promote ${NEW}`])
  assert.equal(result.production, PREV)
})

test("no rollback when someone else promoted after us", async () => {
  const result = await run({ externalPromotionAt: "after-promote" })
  assert.equal(result.outcome, "external-promotion")
  assert.deepEqual(result.mutations, [`promote ${NEW}`])
})

test("rollback API failure and a failed rollback alias job are critical", async () => {
  for (const options of [{ liveHealthy: false, rollbackThrows: true }, { liveHealthy: false, rollbackJob: ["in-progress", "failed"] }]) {
    const result = await run(options)
    assert.equal(result.outcome, "rollback-failed")
    assert.deepEqual(result.mutations, [`promote ${NEW}`, `rollback ${PREV}`])
  }
})

test("superseded release runs waiting for approval are cancelled; running and newer runs are not", async () => {
  const calls: string[] = []
  const github = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return { workflow_runs: [{ id: 10, run_number: 3 }, { id: 11, run_number: 4 }, { id: 12, run_number: 5 }, { id: 13, run_number: 6 }] }
    },
  }
  assert.deepEqual(await cancelSupersededRuns(github, { currentRunId: 12, currentRunNumber: 5 }), [10, 11])
  assert.deepEqual(calls.slice(1), ["POST /repos/{repo}/actions/runs/10/cancel", "POST /repos/{repo}/actions/runs/11/cancel"])
  assert.match(calls[0], /status=waiting/)
})

test("probe responses are reduced to a status string and booleans; anything else in the body is ignored", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok", checks: { database: "yes", blob: true }, secret: "leak", html: "<script>" }), { status: 200 })) as typeof fetch
  try {
    assert.deepEqual(await httpProbe("https://x.vercel.app/api/health/detail"), { status: 200, json: { status: "ok", checks: { database: false, blob: true } } })
    assert.deepEqual(await httpProbe("https://x.vercel.app/api/v1/plans"), { status: 200, json: null })
  } finally {
    globalThis.fetch = original
  }
})
