import assert from "node:assert/strict"
import { test } from "node:test"
// @ts-expect-error plain ESM build script without type declarations
import { smoke } from "../../scripts/ci/preview-smoke.mjs"

const SHA = "b".repeat(40)
const PROJECT = "prj_preview"

function fake({ deployments = [{ uid: "dpl_p", createdAt: 2, meta: { githubCommitSha: SHA } }, { uid: "dpl_other", createdAt: 3, meta: { githubCommitSha: "c".repeat(40) } }], detail = {}, states = ["READY"] }: any = {}) {
  const fetched: string[] = []
  return {
    fetched,
    vercel: {
      listDeployments: async () => deployments,
      getDeployment: async (id: string) => { fetched.push(id); return { id, projectId: PROJECT, url: "plan-manager-preview-abc.vercel.app", readyState: states.length > 1 ? states.shift() : states[0], ...detail } },
    },
  }
}

async function run(options: any = {}, probeResult: (url: string) => any = url => url.endsWith("/api/health") ? { status: 200, json: { status: "ok" } } : { status: 401, json: null }) {
  const { vercel, fetched } = fake(options)
  const probes: any[] = []
  let clock = 0
  const result = await smoke({
    vercel,
    probe: async (url: string, init: any) => { probes.push({ url, ...init }); return probeResult(url) },
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    config: { projectId: PROJECT, sha: SHA, bypass: "preview-bypass", headRepository: options.headRepository ?? "hacker1db/plan-manager", repository: "hacker1db/plan-manager" },
  })
  return { result, probes, fetched }
}

test("fork pull requests are skipped before any API call", async () => {
  const { result, fetched, probes } = await run({ headRepository: "someone/plan-manager" })
  assert.deepEqual(result, { skipped: true, failures: [] })
  assert.deepEqual([fetched, probes], [[], []])
})

test("finds the deployment for the head commit only, then checks liveness and auth with the bypass", async () => {
  const { result, fetched, probes } = await run()
  assert.deepEqual(result, { skipped: false, failures: [], deploymentId: "dpl_p" })
  assert.deepEqual(fetched, ["dpl_p"])
  assert.deepEqual(probes.map(probe => [probe.url, probe.headers["x-vercel-protection-bypass"]]), [
    ["https://plan-manager-preview-abc.vercel.app/api/health", "preview-bypass"],
    ["https://plan-manager-preview-abc.vercel.app/api/v1/plans", "preview-bypass"],
  ])
})

test("a deployment in another project or with an unexpected URL is rejected without probing it", async () => {
  for (const detail of [{ projectId: "prj_production" }, { url: "evil.example.com" }, { url: "x.vercel.app.evil.example" }]) {
    const { result, probes } = await run({ detail })
    assert.equal(result.failures.length, 1, JSON.stringify(detail))
    assert.deepEqual(probes, [])
  }
})

test("only status codes and the health status string count; a hostile body cannot pass the check", async () => {
  const { result } = await run({}, url => url.endsWith("/api/health") ? { status: 200, json: { status: "degraded" } } : { status: 200, json: null })
  assert.deepEqual(result.failures, ["/api/health returned 200", "/api/v1/plans without a session returned 200, expected 401"])
})

test("an ERROR preview fails fast and a missing one times out", async () => {
  await assert.rejects(run({ states: ["BUILDING", "ERROR"] }), /ended ERROR/)
  await assert.rejects(run({ deployments: [] }), /no READY preview deployment/)
})
