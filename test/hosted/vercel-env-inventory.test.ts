import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { test } from "node:test"
import { root } from "./vite-ssr"

const script = resolve(root, "scripts/check-vercel-env.mjs")
const ALL = [
  "WORKOS_CLIENT_ID", "WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD", "WORKOS_REDIRECT_URI", "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN", "PLAN_MANAGER_TOKEN_PEPPER", "PLAN_MANAGER_OWNER_WORKOS_USER_IDS",
  "PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN", "PLAN_MANAGER_WORKOS_CLI_CLIENT_ID", "PLAN_MANAGER_WORKOS_CLI_AUDIENCE",
  "PLAN_MANAGER_HEALTH_DETAIL_TOKEN", // production only
]
// The four names absent from Production in the failed dae8a7d and d9cc3c7 deployments.
const PRODUCTION_GAP = ["WORKOS_API_KEY", "PLAN_MANAGER_OWNER_WORKOS_USER_IDS", "PLAN_MANAGER_WORKOS_CLI_CLIENT_ID", "PLAN_MANAGER_WORKOS_CLI_AUDIENCE"]

function run(inventory: unknown, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { input: JSON.stringify(inventory), env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test("reports the exact production gap from a names-only inventory and never echoes values", () => {
  const envs = [
    ...ALL.filter(key => !PRODUCTION_GAP.includes(key)).map(key => ({ key, target: ["production"], type: "sensitive", value: "placeholder-must-not-print" })),
    { key: "CLERK_SECRET_KEY", target: ["production"], type: "encrypted" },
  ]
  const { status, output } = run({ envs }, "--target", "production")
  assert.equal(status, 1)
  for (const key of PRODUCTION_GAP) assert.match(output, new RegExp(`- ${key}\\b`))
  assert.match(output, /missing 4 of 12/)
  assert.equal(output.includes("placeholder-must-not-print"), false)
})

test("passes when every required name exists for each target", () => {
  const envs = ALL.map(key => ({ key, target: ["production", "preview", "development"], type: "encrypted" }))
  const { status, output } = run({ envs })
  assert.equal(status, 0, output)
  assert.match(output, /production: all 12/)
  assert.match(output, /preview: all 11/)
})

test("treats a name set only for another target as missing", () => {
  const envs = ALL.map(key => ({ key, target: key === "WORKOS_API_KEY" ? ["preview"] : ["production"], type: "encrypted" }))
  const { status, output } = run(envs, "--target", "production")
  assert.equal(status, 1)
  assert.match(output, /- WORKOS_API_KEY\b/)
})

test("rejects malformed inventory and unknown targets", () => {
  assert.equal(run({ nope: true }).status, 2)
  assert.equal(run({ envs: [] }, "--target", "staging").status, 2)
})
