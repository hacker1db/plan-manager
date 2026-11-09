import assert from "node:assert/strict"
import {after, beforeEach, test} from "node:test"
import {closeViteServer, load} from "./vite-ssr"
after(closeViteServer)
const ENV = {WORKOS_CLIENT_ID: "client_web", WORKOS_API_KEY: "sk_test_fake", WORKOS_COOKIE_PASSWORD: "fixture-only-".repeat(4), WORKOS_REDIRECT_URI: "https://plans.example/callback", PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner", DATABASE_URL: "postgres://fake", BLOB_READ_WRITE_TOKEN: "fake", PLAN_MANAGER_TOKEN_PEPPER: "pepper", PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: "https://auth.example", PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: "client_cli", PLAN_MANAGER_WORKOS_CLI_AUDIENCE: "plans"}
beforeEach(async () => { (await load("/src/lib/server/env.ts")).setEnvironmentSource(ENV) })
test("WorkOS owner routes reject anonymous and non-owner sessions before storage", async () => {
  for (const path of ["/src/routes/api/plans/+server.ts", "/src/routes/api/v1/plans/+server.ts", "/src/routes/api/v1/plans/[id]/content/+server.ts"]) {
    const {GET} = await load(path)
    for (const [user, status] of [[null,401],[{id:"other"},403]] as const) {
      const response = await GET({url:new URL("https://plans.example/api/v1/plans"),params:{id:"plan_1234"},locals:{auth:{user}}})
      assert.equal(response.status,status)
    }
  }
})
test("WorkOS owner authorization fails closed and rejects Clerk identities", async () => {
  const {requireOwnerResponse} = await load("/src/lib/server/auth.ts")
  assert.equal(requireOwnerResponse({user:{id:"user_owner"}}),null)
  assert.equal(requireOwnerResponse({user:{id:"old_clerk_owner"}}).status,403)
  ;(await load("/src/lib/server/env.ts")).setEnvironmentSource({})
  assert.equal(requireOwnerResponse({user:{id:"user_owner"}}).status,503)
})
test("WorkOS sign-out rejects cross-site POST and GET does not revoke", async () => {
  const {POST,GET} = await load("/src/routes/sign-out/+server.ts")
  assert.equal(POST({url:new URL("https://plans.example/sign-out"),request:new Request("https://plans.example/sign-out",{method:"POST",headers:{Origin:"https://other.example"}})}).status,403)
  assert.throws(()=>GET({}), (error: any)=>error.status===303)
})
test("Connect discovery retains explicit client, audience, issuer and scope", async () => {
  const {GET} = await load("/src/routes/api/v1/+server.ts")
  const response = await GET({})
  assert.equal(response.status,200)
  const config = await response.json()
  assert.equal(config.version,2)
  assert.equal(config.scope,"plans:write")
  assert.equal(config.issuerUrl,"https://auth.example")
})


test("mobile routes reject anonymous and non-owner WorkOS sessions before storage", async () => {
  for (const [path, method] of [["render", "GET"], ["status", "POST"]]) {
    const handler = (await load(`/src/routes/api/v1/plans/[id]/${path}/+server.ts`))[method]
    for (const [user, status] of [[null, 401], [{id: "other"}, 403]] as const) {
      const response = await handler({request: new Request("https://plans.example/x", {method}), params: {id: "plan_1234"}, locals: {auth: {user}}})
      assert.equal(response.status, status)
    }
  }
})

test("native status keeps cookie CSRF and rejects unverified bearer credentials", async () => {
  const {POST} = await load("/src/routes/api/v1/plans/[id]/status/+server.ts")
  const call = (headers: Record<string, string>) => POST({request: new Request("https://plans.example/api/v1/plans/plan_1234/status", {method: "POST", headers, body: "not json"}), params: {id: "plan_1234"}, locals: {auth: {user: {id: "user_owner"}}}})
  assert.equal((await call({"Content-Type": "application/json"})).status, 403)
  assert.equal((await call({"Content-Type": "application/json", Origin: "https://evil.example"})).status, 403)
  assert.equal((await call({"Content-Type": "application/json", Authorization: "Bearer forged", Cookie: "session=valid"})).status, 403)
  assert.equal((await call({"Content-Type": "application/json", Authorization: "Bearer forged"})).status, 403)
  assert.equal((await call({"Content-Type": "application/json", Origin: "https://plans.example"})).status, 400)
})
