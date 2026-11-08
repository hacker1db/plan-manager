import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import type { AuthReader, RequestAuth } from "../../src/lib/server/auth"
import type { ClerkRequestState } from "../../src/lib/server/clerk"
import { closeViteServer, load } from "./vite-ssr"

// Auth regression checks for the SvelteKit port. Route and hook modules are loaded through
// Vite exactly as SvelteKit bundles them; Clerk is replaced by a fake request state except in
// the final tests, which drive the real @clerk/backend SDK offline.

after(closeViteServer)

const publishableKey = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64url")}`
const ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
  CLERK_SECRET_KEY: "sk_test_fake",
  PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_owner,user_second",
  DATABASE_URL: "postgres://user:pass@127.0.0.1:9/none",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fake",
  PLAN_MANAGER_TOKEN_PEPPER: "pepper",
  PLAN_MANAGER_OAUTH_CLIENT_ID: "cli_client",
}

type Env = Record<string, string | undefined>

async function useEnv(env: Env): Promise<void> {
  const module = await load("/src/lib/server/env.ts")
  module.setEnvironmentSource(env)
}

beforeEach(() => useEnv(ENV))

const SIGNED_OUT: RequestAuth = { isAuthenticated: false, userId: null, clientId: null, scopes: null }
const session = (userId: string): AuthReader => (accepts = "session_token") => accepts === "session_token" ? { isAuthenticated: true, userId } : SIGNED_OUT
const oauth = (userId: string, clientId: string, scopes: string[]): AuthReader => accepts => accepts === "oauth_token" ? { isAuthenticated: true, userId, clientId, scopes } : SIGNED_OUT
const anonymous: AuthReader = () => SIGNED_OUT

function fakeState(auth: AuthReader, status: ClerkRequestState["status"] = "signed-in", headers = new Headers()): ClerkRequestState {
  return { status, headers, auth, redirectToSignIn: () => new Response(null, { status: 307, headers: { Location: "https://accounts.example.dev/sign-in?redirect_url=x" } }) }
}

async function runHook(pathname: string, state: ClerkRequestState | null, env: Env = ENV) {
  const { createHandle } = await load("/src/lib/server/gate.ts")
  let authenticated = 0
  let resolved = false
  const event = { url: new URL(`https://plans.example${pathname}`), request: new Request(`https://plans.example${pathname}`), locals: {} as { auth?: AuthReader } }
  const handle = createHandle(async () => { authenticated++; if (!state) throw new Error("not configured"); return state }, () => env)
  const response: Response = await handle({ event, resolve: async () => { resolved = true; return new Response("ok") } })
  return { response, resolved, authenticated, locals: event.locals }
}

test("hook: unauthenticated page and API requests redirect to Clerk sign-in", async () => {
  for (const path of ["/", "/plans", "/plans/plan_1234", "/api/plans", "/api/plans/plan_1234/status"]) {
    const { response, resolved } = await runHook(path, fakeState(anonymous, "signed-out"))
    assert.equal(response.status, 307, path)
    assert.match(response.headers.get("location") ?? "", /sign-in/)
    assert.equal(resolved, false)
  }
})

test("hook: signed-in non-owners are forbidden; allowlisted owners pass", async () => {
  const denied = await runHook("/plans", fakeState(session("user_other")))
  assert.equal(denied.response.status, 403)
  assert.equal(await denied.response.text(), "Forbidden")
  assert.equal(denied.resolved, false)
  for (const owner of ["user_owner", "user_second"]) {
    const allowed = await runHook("/plans", fakeState(session(owner)))
    assert.equal(allowed.response.status, 200)
    assert.equal(allowed.resolved, true)
    assert.equal(allowed.locals.auth?.("session_token").userId, owner)
  }
  const legacy = await runHook("/plans", fakeState(session("user_old")), { ...ENV, PLAN_MANAGER_OWNER_CLERK_USER_IDS: undefined, PLAN_MANAGER_OWNER_CLERK_USER_ID: "user_old" })
  assert.equal(legacy.resolved, true)
})

test("hook: an OAuth token is not a browser session", async () => {
  const { response, resolved } = await runHook("/plans", fakeState(oauth("user_owner", "cli_client", ["openid"])))
  assert.equal(response.status, 307)
  assert.equal(resolved, false)
})

test("hook: sign-in and the CLI /api/v1 surface bypass the owner gate but still get Clerk auth", async () => {
  for (const path of ["/sign-in", "/sign-in/factor-one", "/api/v1", "/api/v1/plans", "/api/v1/plans/plan_1234/versions"]) {
    const { resolved, authenticated, locals } = await runHook(path, fakeState(anonymous, "signed-out"))
    assert.equal(resolved, true, path)
    assert.equal(authenticated, 1, path)
    assert.equal(typeof locals.auth, "function")
  }
  assert.equal((await runHook("/api/v1x", fakeState(anonymous, "signed-out"))).resolved, false)
  assert.equal((await runHook("/api/v1x", fakeState(anonymous, "signed-out"))).response.status, 307)
})

test("hook: fails closed with 503 when Clerk keys or the owner allowlist are missing", async () => {
  for (const env of [{ ...ENV, CLERK_SECRET_KEY: "" }, { ...ENV, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined }, { ...ENV, PLAN_MANAGER_OWNER_CLERK_USER_IDS: " , " }]) {
    const { response, resolved } = await runHook("/plans", fakeState(session("user_owner")), env)
    assert.equal(response.status, 503)
    assert.equal(await response.text(), "Hosted service is unavailable")
    assert.equal(resolved, false)
  }
  const cli = await runHook("/api/v1", null, { ...ENV, CLERK_SECRET_KEY: "" })
  assert.equal(cli.resolved, true)
  assert.equal(cli.authenticated, 0)
  assert.equal(cli.locals.auth?.("session_token").userId, null)
})

test("hook: Clerk handshakes redirect before any route runs and request-state cookies are forwarded", async () => {
  const headers = new Headers({ Location: "https://example.clerk.accounts.dev/v1/client/handshake?redirect_url=x" })
  const handshake = await runHook("/plans", fakeState(anonymous, "handshake", headers))
  assert.equal(handshake.response.status, 307)
  assert.match(handshake.response.headers.get("location")!, /handshake/)
  assert.equal(handshake.resolved, false)
  const cookieHeaders = new Headers()
  cookieHeaders.append("Set-Cookie", "__clerk_db_jwt=abc; Path=/")
  const owner = await runHook("/plans", fakeState(session("user_owner"), "signed-in", cookieHeaders))
  assert.match(owner.response.headers.get("set-cookie") ?? "", /__clerk_db_jwt=abc/)
})

type Handler = (event: Record<string, unknown>) => Promise<Response> | Response

async function route(path: string, method: string): Promise<Handler> {
  const module = await load(path)
  assert.equal(typeof module[method], "function", `${path} exports ${method}`)
  return module[method]
}

function event(url: string, auth: AuthReader, init: RequestInit = {}, params: Record<string, string> = {}) {
  const request = new Request(url, init)
  return { request, url: new URL(url), params, locals: { auth } }
}

test("owner APIs: 401 signed out, 403 non-owner or OAuth-only, 503 unconfigured", async () => {
  const owned: Array<[string, string, Record<string, string>, RequestInit]> = [
    ["/src/routes/api/plans/+server.ts", "GET", {}, {}],
    ["/src/routes/api/plans/[id]/+server.ts", "GET", { id: "plan_1234" }, {}],
    ["/src/routes/api/plans/[id]/status/+server.ts", "POST", { id: "plan_1234" }, { method: "POST" }],
    ["/src/routes/api/v1/plans/+server.ts", "GET", {}, {}],
    ["/src/routes/api/v1/plans/[id]/+server.ts", "GET", { id: "plan_1234" }, {}],
    ["/src/routes/api/v1/plans/[id]/content/+server.ts", "GET", { id: "plan_1234" }, {}],
    ["/src/routes/api/v1/tokens/+server.ts", "POST", {}, { method: "POST" }],
    ["/src/routes/api/v1/tokens/[id]/+server.ts", "DELETE", { id: "tok" }, { method: "DELETE" }],
  ]
  for (const [path, method, params, init] of owned) {
    const handler = await route(path, method)
    const call = (auth: AuthReader) => handler(event("https://plans.example/x", auth, init, params))
    assert.equal((await call(anonymous)).status, 401, `${path} signed out`)
    const nonOwner = await call(session("user_other"))
    assert.equal(nonOwner.status, 403, `${path} non-owner`)
    assert.deepEqual(await nonOwner.json(), { error: "Forbidden" })
    assert.equal((await call(oauth("user_owner", "cli_client", ["openid"]))).status, 401, `${path} OAuth token is not a session`)
    await useEnv({ ...ENV, PLAN_MANAGER_TOKEN_PEPPER: undefined })
    assert.equal((await call(session("user_owner"))).status, 503, `${path} unconfigured`)
    await useEnv(ENV)
  }
})

test("owner mutations keep exact-origin and JSON protections after authorization", async () => {
  const status = await route("/src/routes/api/plans/[id]/status/+server.ts", "POST")
  const crossSite = await status(event("https://plans.example/api/plans/plan_1234/status", session("user_owner"), { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" }, { id: "plan_1234" }))
  assert.equal(crossSite.status, 403)
  const noOrigin = await status(event("https://plans.example/api/plans/plan_1234/status", session("user_owner"), { method: "POST", body: "{}" }, { id: "plan_1234" }))
  assert.equal(noOrigin.status, 403)
  const invalid = await status(event("https://plans.example/api/plans/plan_1234/status", session("user_owner"), { method: "POST", headers: { Origin: "https://plans.example" }, body: JSON.stringify({ status: "in-progress" }) }, { id: "plan_1234" }))
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: "Invalid plan status" })

  const tokens = await route("/src/routes/api/v1/tokens/+server.ts", "POST")
  const textPlain = await tokens(event("https://plans.example/api/v1/tokens", session("user_owner"), { method: "POST", headers: { Origin: "https://plans.example", "Content-Type": "text/plain" }, body: "{}" }))
  assert.equal(textPlain.status, 415)
  const crossToken = await tokens(event("https://plans.example/api/v1/tokens", session("user_owner"), { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" }))
  assert.equal(crossToken.status, 403)
  const revoke = await route("/src/routes/api/v1/tokens/[id]/+server.ts", "DELETE")
  assert.equal((await revoke(event("https://plans.example/api/v1/tokens/x", session("user_owner"), { method: "DELETE", headers: { Origin: "https://evil.example" } }, { id: "x" }))).status, 403)
})

test("CLI upload accepts only OAuth tokens from the CLI client for owners with openid, or pm_ tokens", async () => {
  const put = await route("/src/routes/api/v1/plans/[id]/versions/+server.ts", "PUT")
  const call = (auth: AuthReader, authorization?: string) => put(event("https://plans.example/api/v1/plans/plan_1234/versions", auth, {
    method: "PUT",
    headers: authorization ? { Authorization: authorization, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: "not json",
  }, { id: "plan_1234" }))
  assert.equal((await call(anonymous)).status, 401, "no Authorization header")
  assert.equal((await call(session("user_owner"))).status, 401, "browser session cookies cannot upload")
  assert.equal((await call(anonymous, "Basic abc")).status, 401, "non-bearer scheme")
  assert.equal((await call(session("user_owner"), "Bearer session.jwt.value")).status, 401, "session JWT as bearer")
  assert.equal((await call(oauth("user_other", "cli_client", ["openid"]), "Bearer oat_x")).status, 403, "non-owner")
  assert.equal((await call(oauth("user_owner", "other_client", ["openid"]), "Bearer oat_x")).status, 403, "wrong OAuth client")
  assert.equal((await call(oauth("user_owner", "cli_client", ["offline_access"]), "Bearer oat_x")).status, 403, "missing openid scope")
  await useEnv({ ...ENV, PLAN_MANAGER_OAUTH_CLIENT_ID: undefined })
  assert.equal((await call(oauth("user_owner", "cli_client", ["openid"]), "Bearer oat_x")).status, 403, "CLI client unset")
  await useEnv(ENV)
  // Authorized: the request reaches body parsing (invalid JSON → 400) without touching storage.
  const allowed = await call(oauth("user_owner", "cli_client", ["openid", "offline_access"]), "Bearer oat_x")
  assert.equal(allowed.status, 400)
  assert.deepEqual(await allowed.json(), { error: "Invalid JSON" })
  assert.equal((await call(anonymous, "Bearer pm_short")).status, 401, "malformed pm_ token")
})

test("pm_ tokens: unknown, wrong secret, expired, revoked, and read-only tokens cannot write", async () => {
  const { requireWriteToken } = await load("/src/lib/server/auth.ts")
  const { generateToken, hashSecret } = await load("/src/lib/server/token.ts")
  const generated = generateToken("abcdefgh")
  const secretHash = await hashSecret(generated.secret, ENV.PLAN_MANAGER_TOKEN_PEPPER)
  const base = { id: generated.id, secretHash, scopes: ["plans:write"], expiresAt: new Date(Date.now() + 60_000), revokedAt: null }
  const request = (bearer: string) => new Request("https://plans.example/api/v1/plans/x/versions", { method: "PUT", headers: { Authorization: `Bearer ${bearer}` } })
  const check = async (record: unknown, bearer = generated.bearer) => (await requireWriteToken(request(bearer), "plans:write", anonymous, async () => record))?.status ?? 200
  assert.equal(await check(base), 200)
  assert.equal(await check(null), 403, "unknown token id")
  assert.equal(await check(base, `pm_${generated.id}_${"x".repeat(43)}`), 403, "wrong secret")
  assert.equal(await check({ ...base, expiresAt: new Date(Date.now() - 1) }), 403, "expired")
  assert.equal(await check({ ...base, revokedAt: new Date() }), 403, "revoked")
  assert.equal(await check({ ...base, scopes: ["plans:read"] }), 403, "read-only scope")
  await useEnv({ ...ENV, PLAN_MANAGER_TOKEN_PEPPER: undefined })
  assert.equal(await check(base), 503, "pepper missing")
})

test("plan detail page hides plans from non-owners and signed-out users as 404", async () => {
  const { load: pageLoad } = await load("/src/routes/plans/[id]/+page.server.ts")
  for (const auth of [anonymous, session("user_other"), oauth("user_owner", "cli_client", ["openid"])]) {
    await assert.rejects(pageLoad({ params: { id: "plan_1234" }, locals: { auth }, setHeaders() {} }), (error: { status?: number }) => error.status === 404)
  }
  await assert.rejects(pageLoad({ params: { id: "../../x" }, locals: { auth: session("user_owner") }, setHeaders() {} }), (error: { status?: number }) => error.status === 404)
})

test("GET /api/v1 is public and exposes only the CLI client ID and Clerk issuer", async () => {
  const get = await route("/src/routes/api/v1/+server.ts", "GET")
  const response = await get(event("https://plans.example/api/v1", anonymous))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { version: 1, clientId: "cli_client", issuerUrl: "https://example.clerk.accounts.dev" })
  assert.equal(response.headers.get("cache-control"), "public, max-age=300")
  await useEnv({ ...ENV, PLAN_MANAGER_OAUTH_CLIENT_ID: "" })
  const missing = await get(event("https://plans.example/api/v1", anonymous))
  assert.equal(missing.status, 503)
  assert.deepEqual(await missing.json(), { error: "CLI authentication is not configured" })
})

test("layout data sends the browser only the publishable key and sign-in URL", async () => {
  const { load: layoutLoad } = await load("/src/routes/+layout.server.ts")
  assert.deepEqual(layoutLoad({}), { clerk: { publishableKey, signInUrl: null } })
  await useEnv({ ...ENV, NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in" })
  assert.deepEqual(layoutLoad({}), { clerk: { publishableKey, signInUrl: "/sign-in" } })
})

test("real Clerk SDK: anonymous and non-Clerk bearer requests are signed out; sign-in redirect keeps the return URL", async () => {
  const { createClerkAuthenticator } = await load("/src/lib/server/clerk.ts")
  const authenticate = createClerkAuthenticator(() => ENV)
  const api = await authenticate(new Request("https://plans.example/api/plans", { headers: { Accept: "application/json" } }))
  assert.notEqual(api.status, "signed-in")
  assert.equal(api.auth("session_token").userId, null)
  assert.equal(api.auth("oauth_token").isAuthenticated, false)
  const redirect = api.redirectToSignIn()
  assert.equal(redirect.status, 307)
  const location = new URL(redirect.headers.get("location")!)
  assert.equal(location.origin, "https://example.accounts.dev")
  assert.equal(location.pathname, "/sign-in")
  assert.equal(location.searchParams.get("redirect_url"), "https://plans.example/api/plans")
  for (const bearer of [`pm_${"a".repeat(18)}_${"b".repeat(43)}`, "not-a-jwt"]) {
    const state = await authenticate(new Request("https://plans.example/api/v1/plans/x/versions", { method: "PUT", headers: { Authorization: `Bearer ${bearer}` } }))
    assert.equal(state.auth("session_token").userId, null)
    assert.equal(state.auth("oauth_token").isAuthenticated, false)
  }
  const local = createClerkAuthenticator(() => ({ ...ENV, NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in" }))
  const localRedirect = (await local(new Request("https://plans.example/plans/abc", { headers: { Accept: "application/json" } }))).redirectToSignIn()
  const target = new URL(localRedirect.headers.get("location")!)
  assert.equal(`${target.origin}${target.pathname}`, "https://plans.example/sign-in")
  assert.equal(target.searchParams.get("redirect_url"), "https://plans.example/plans/abc")
})
