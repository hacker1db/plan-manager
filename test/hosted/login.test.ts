import assert from "node:assert/strict"
import {after, before, test} from "node:test"
import {authKit, authKitHandle} from "@workos/authkit-sveltekit"
import {closeViteServer, load} from "./vite-ssr"
after(closeViteServer)

// AuthKit falls back to process.env when hooks.server.ts has not configured it. Fixture values only.
const FIXTURE = {WORKOS_CLIENT_ID: "client_web", WORKOS_API_KEY: "sk_test_fake", WORKOS_REDIRECT_URI: "https://plans.example/callback", WORKOS_COOKIE_PASSWORD: "fixture-only-".repeat(4)}
const saved = Object.fromEntries(Object.keys(FIXTURE).map(key => [key, process.env[key]]))
before(() => { Object.assign(process.env, FIXTURE) })
after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value })

async function signInRedirect(route: string, query = ""): Promise<URL> {
  const {GET} = await load(`/src/routes/${route}/+server.ts`)
  const url = new URL(`https://plans.example/${route}${query}`)
  const cookies = {get: () => undefined, getAll: () => [], set: () => {}, delete: () => {}, serialize: () => ""}
  const event: any = {url, request: new Request(url), cookies, locals: {}, route: {id: `/${route}`}, params: {}}
  // authKitHandle supplies the request context getSignInUrl needs, exactly as hooks.server.ts does.
  try { await authKitHandle()({event, resolve: (e: any) => GET(e)}) } catch (error: any) {
    assert.equal(error.status, 303, String(error?.stack ?? error))
    return new URL(error.location)
  }
  assert.fail("expected a redirect")
}

// Record what each handler hands AuthKit while still running the real getSignInUrl.
const requested: Array<string | undefined> = []
const realGetSignInUrl = authKit.getSignInUrl
before(() => { authKit.getSignInUrl = (options: any) => { requested.push(options?.returnTo); return realGetSignInUrl(options) } })
after(() => { authKit.getSignInUrl = realGetSignInUrl })

async function returnToFor(route: string, returnTo: string): Promise<string | undefined> {
  requested.length = 0
  const location = await signInRedirect(route, `?returnTo=${encodeURIComponent(returnTo)}`)
  assert.equal(location.origin, "https://api.workos.com")
  // authKitHandle re-runs resolve after a thrown redirect, so a request may record more than once.
  assert.ok(requested.length >= 1)
  assert.equal(new Set(requested).size, 1)
  return requested[0]
}

for (const route of ["login", "sign-in"]) {
  test(`/${route} starts the WorkOS AuthKit sign-in flow`, async () => {
    requested.length = 0
    const location = await signInRedirect(route)
    assert.equal(location.origin, "https://api.workos.com")
    assert.equal(location.searchParams.get("client_id"), "client_web")
    assert.equal(location.searchParams.get("redirect_uri"), "https://plans.example/callback")
    assert.ok(location.searchParams.get("state"), "AuthKit sealed state is present")
    assert.deepEqual([...new Set(requested)], ["/plans"])
  })

  test(`/${route} preserves a safe return path`, async () => {
    assert.equal(await returnToFor(route, "/plans/plan_1234?tab=notes#c2"), "/plans/plan_1234?tab=notes#c2")
  })

  test(`/${route} rejects open redirects and falls back to /plans`, async () => {
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "/\tevil", "/login", "/sign-in?returnTo=/x", "/callback", "/auth/error"]) {
      assert.equal(await returnToFor(route, bad), "/plans", bad)
    }
  })
}

test("safeReturnTo keeps same-origin paths only", async () => {
  const {safeReturnTo} = await load("/src/lib/server/sign-in.ts")
  for (const bad of [null, undefined, "", "plans", "/sign-out", "/" + "a".repeat(3000), "/\u0000x"]) assert.equal(safeReturnTo(bad), "/plans", String(bad))
  assert.equal(safeReturnTo("/plans/abc?x=1#y"), "/plans/abc?x=1#y")
  // Dot segments normalize to a protocol-relative "//host" path; must be rejected after parsing.
  for (const bad of ["/.//evil.example", "/./\u002f/evil.example", "/%2e//evil.example", "/%2E//evil.example", "/a/..//evil.example", "/x/../..//evil.example"]) {
    const result = safeReturnTo(bad)
    assert.equal(result, "/plans", bad)
    assert.equal(result.startsWith("//"), false, bad)
  }
  for (const loop of ["/login/", "/LOGIN", "/Sign-In", "/auth", "/auth/", "/./login", "/x/../callback"]) assert.equal(safeReturnTo(loop), "/plans", loop)
})

test("unauthenticated redirects point at /login with a safe returnTo", async () => {
  const {loginLocation} = await load("/src/lib/server/sign-in.ts")
  assert.equal(loginLocation(new URL("https://plans.example/plans/abc?x=1")), "/login?returnTo=%2Fplans%2Fabc%3Fx%3D1")
  assert.equal(loginLocation(new URL("https://plans.example/login")), "/login?returnTo=%2Fplans")
})
