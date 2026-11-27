import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { closeViteServer, load } from "./vite-ssr"
after(closeViteServer)

const TOKEN = "ci-fixture-health-detail-token-not-real-0000"
const ENV = {
  WORKOS_CLIENT_ID: "client_web", WORKOS_API_KEY: "ci-fixture-workos-api-key", WORKOS_COOKIE_PASSWORD: "ci-fixture-".repeat(4),
  WORKOS_REDIRECT_URI: "https://plans.example/callback", PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner", DATABASE_URL: "postgres://fake",
  BLOB_READ_WRITE_TOKEN: "fake", PLAN_MANAGER_TOKEN_PEPPER: "pepper", PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: "https://auth.example",
  PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: "client_cli", PLAN_MANAGER_WORKOS_CLI_AUDIENCE: "plans", PLAN_MANAGER_HEALTH_DETAIL_TOKEN: TOKEN,
}
const calls: string[] = []
const check = (name: string, result: boolean | Error) => async () => { calls.push(name); if (result instanceof Error) throw result; return result }

async function setup(env: Record<string, string> = ENV, results: Record<string, boolean | Error> = {}) {
  ;(await load("/src/lib/server/env.ts")).setEnvironmentSource(env)
  ;(await load("/src/lib/server/health.ts")).setHealthChecks({
    database: check("database", results.database ?? true), blob: check("blob", results.blob ?? true),
    workos: check("workos", results.workos ?? true), cliJwks: check("cliJwks", results.cliJwks ?? true),
  })
}

async function detail(authorization?: string) {
  const { GET } = await load("/src/routes/api/health/detail/+server.ts")
  const response: Response = await GET({ request: new Request("https://plans.example/api/health/detail", { headers: authorization ? { authorization } : {} }) })
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") }
}

beforeEach(async () => { calls.length = 0; await setup() })

test("health detail rejects a missing, wrong, or malformed bearer token without running any check", async () => {
  for (const header of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`, "Bearer "]) {
    const result = await detail(header)
    assert.equal(result.status, 401, String(header))
    assert.equal(JSON.stringify(result.body).includes(TOKEN), false)
  }
  assert.deepEqual(calls, [])
})

test("health detail fails closed (503) when its token is unset or too short, even for a matching header", async () => {
  for (const value of [undefined, "", "short-token"]) {
    const env: Record<string, string> = { ...ENV }
    if (value === undefined) delete env.PLAN_MANAGER_HEALTH_DETAIL_TOKEN
    else env.PLAN_MANAGER_HEALTH_DETAIL_TOKEN = value
    await setup(env)
    const result = await detail(`Bearer ${value ?? ""}`)
    assert.equal(result.status, 503, String(value))
    assert.equal(result.body.error, "Health detail is not configured")
  }
  assert.deepEqual(calls, [])
})

test("health detail with the right token returns booleans only", async () => {
  const ok = await detail(`Bearer ${TOKEN}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.cache, "no-store")
  assert.deepEqual(ok.body, { status: "ok", checks: { database: true, blob: true, workos: true, cliJwks: true } })
  await setup(ENV, { workos: false, blob: new Error(`boom ${TOKEN} postgres://secret`) })
  const degraded = await detail(`Bearer ${TOKEN}`)
  assert.equal(degraded.status, 503)
  assert.deepEqual(degraded.body, { status: "degraded", checks: { database: true, blob: false, workos: false, cliJwks: true } })
  assert.equal(JSON.stringify(degraded.body).includes("boom"), false)
})

test("public liveness says only ok or unconfigured", async () => {
  const { GET } = await load("/src/routes/api/health/+server.ts")
  const ok: Response = await GET({})
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { status: "ok" })
  ;(await load("/src/lib/server/env.ts")).setEnvironmentSource({})
  const down: Response = await GET({})
  assert.equal(down.status, 503)
  assert.deepEqual(await down.json(), { status: "unconfigured" })
  assert.deepEqual(calls, [])
})
