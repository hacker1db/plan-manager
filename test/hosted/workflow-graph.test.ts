import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import yaml from "js-yaml"
import { root } from "./vite-ssr"

const workflow = (name: string) => yaml.load(readFileSync(resolve(root, ".github/workflows", name), "utf8")) as any
const runs = (job: any) => (job.steps ?? []).map((step: any) => String(step.run ?? step.uses ?? ""))
const needs = (job: any) => [job.needs ?? []].flat()

test("release: the names-only preflight gates the deploy; nothing deploys outside the gated release job", () => {
  const { jobs } = workflow("release.yml")
  assert.ok(runs(jobs.preflight).some((run: string) => run.includes("env-drift.mjs --preflight")))
  assert.equal(jobs.preflight.environment, "env-audit")
  assert.equal(jobs.preflight.steps[0].with.ref, "${{ github.event.workflow_run.head_sha }}", "preflight checks the contract of the commit being released")
  assert.ok(needs(jobs.release).includes("preflight"))
  assert.equal(jobs.release.environment, "production-release")
  const steps = runs(jobs.release)
  const recheck = steps.findIndex((run: string) => run.includes("env-drift.mjs --preflight"))
  const build = steps.findIndex((run: string) => run.includes('"$VERCEL_CLI" build'))
  const deploy = steps.findIndex((run: string) => run.includes('"$VERCEL_CLI" deploy'))
  assert.ok(recheck >= 0 && recheck < build && build < deploy, "re-check, then build, then deploy")
  assert.ok(steps[deploy].includes("--skip-domain"), "the deploy is staged; release.mjs promotes")
  for (const [name, job] of Object.entries<any>(jobs)) if (name !== "release") assert.ok(!runs(job).some((run: string) => /vercel(_CLI")? (deploy|promote|rollback)/.test(run)), `${name} must not deploy`)
})

test("ci: ci-required depends on the fixture build that must pass and the empty-env build that must fail", () => {
  const { jobs } = workflow("ci.yml")
  assert.ok(needs(jobs["ci-required"]).includes("build"))
  const steps = runs(jobs.build)
  assert.ok(steps.includes("node scripts/ci-production-build.mjs"))
  assert.ok(steps.includes("node scripts/ci/empty-env-build.mjs"))
  assert.equal(jobs["ci-required"].if, "always()")
})
