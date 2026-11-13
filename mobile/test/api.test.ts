import { ApiError, createApiRepository } from "../src/lib/api"
import { isConfigured } from "../src/lib/config"
import { createFixtureRepository } from "../src/lib/fixtures"
import { visiblePlans } from "../src/lib/filter"
import type { Plan } from "../src/lib/shared"

const plan = (id: string, updated: string, extra: Partial<Plan> = {}): Plan => ({ id, title: `Plan ${id}`, status: "active", tags: [], created: updated, updated, revision: "a".repeat(64), ...extra })

function fakeFetch(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

test("library pages through v1 with bearer auth, dedupes, and sorts newest first", async () => {
  const { calls, fetchImpl } = fakeFetch(url => url.searchParams.get("offset") === "0"
    ? json({ version: 1, plans: [plan("p1", "2026-01-01"), plan("p2", "2026-03-01")], nextOffset: 100 })
    : json({ version: 1, plans: [plan("p2", "2026-03-01"), plan("p3", "2026-02-01")], nextOffset: null }))
  const repository = createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl })
  expect((await repository.library()).map(item => item.id)).toEqual(["p2", "p3", "p1"])
  expect(calls.map(call => `${call.url.pathname}?${call.url.searchParams}`)).toEqual(["/api/v1/plans?limit=100&offset=0", "/api/v1/plans?limit=100&offset=100"])
  for (const call of calls) {
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt")
    expect(call.init.credentials).toBe("omit")
    expect(call.init.redirect).toBe("error")
  }
})

test("library refuses a non-advancing nextOffset instead of looping", async () => {
  const { fetchImpl } = fakeFetch(() => json({ version: 1, plans: [], nextOffset: 0 }))
  await expect(createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl }).library()).rejects.toMatchObject({ kind: "unavailable" })
})

test("status change posts the viewed revision as JSON to an encoded path", async () => {
  const { calls, fetchImpl } = fakeFetch(() => json(plan("p 1", "2026-01-01", { status: "completed" })))
  const repository = createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl })
  await repository.setStatus(plan("p 1", "2026-01-01"), "completed")
  expect(calls[0].url.pathname).toBe("/api/v1/plans/p%201/status")
  expect(calls[0].init.method).toBe("POST")
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: "completed", expectedRevision: "a".repeat(64) })
})

test("HTTP failures map to user-facing error kinds", async () => {
  for (const [status, kind] of [[401, "signedOut"], [403, "forbidden"], [404, "notFound"], [409, "conflict"], [422, "locked"], [500, "unavailable"], [503, "unavailable"]] as const) {
    const { fetchImpl } = fakeFetch(() => json({ error: "x" }, status))
    await expect(createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl }).document("p1")).rejects.toMatchObject({ kind })
  }
  const offline = (async () => { throw new TypeError("Network request failed") }) as unknown as typeof fetch
  await expect(createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl: offline }).document("p1")).rejects.toMatchObject({ kind: "transport" })
})

test("responses that were redirected off-origin are rejected", async () => {
  const redirected = (async () => Object.defineProperty(json({}), "redirected", { value: true })) as unknown as typeof fetch
  await expect(createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl: redirected }).document("p1")).rejects.toMatchObject({ kind: "unavailable" })
  const offOrigin = (async () => Object.defineProperty(json({}), "url", { value: "https://evil.example/api/v1/plans/p1/render" })) as unknown as typeof fetch
  await expect(createApiRepository({ baseUrl: "https://plans.example", getToken: async () => "jwt", fetchImpl: offOrigin }).document("p1")).rejects.toMatchObject({ kind: "unavailable" })
})

test("non-HTTPS service URLs are refused before any request", () => {
  expect(() => createApiRepository({ baseUrl: "http://plans.example", getToken: async () => "jwt" })).toThrow(ApiError)
  expect(() => createApiRepository({ baseUrl: "https://user:pw@plans.example", getToken: async () => "jwt" })).toThrow(ApiError)
})

test("configuration requires a WorkOS client, HTTPS origin, and reverse-domain private redirect", () => {
  const good = { serviceUrl: "https://planmanager.hacker1db.dev", clientId: "client_01ABC", redirectUri: "dev.hacker1db.planmanager://callback", fixtures: false, t3Repo: "" }
  expect(isConfigured(good)).toBe(true)
  for (const patch of [
    { clientId: "" }, { clientId: "abc" },
    { serviceUrl: "http://planmanager.hacker1db.dev" }, { serviceUrl: "https://planmanager.hacker1db.dev/path" }, { serviceUrl: "https://u@planmanager.hacker1db.dev" },
    { redirectUri: "planmanager://callback" }, { redirectUri: "http://localhost:8081/callback" }, { redirectUri: "dev.hacker1db.planmanager://callback?x=1" },
  ]) expect(isConfigured({ ...good, ...patch })).toBe(false)
})

test("fixtures reject stale status writes and filter matches title, tag and status", async () => {
  const fixtures = createFixtureRepository()
  const [sample] = await fixtures.library()
  const updated = await fixtures.setStatus(sample, "completed")
  expect(updated.status).toBe("completed")
  await expect(fixtures.setStatus(sample, "archived")).rejects.toMatchObject({ kind: "conflict" })

  const plans = [plan("a", "1", { title: "Mobile review", tags: ["Expo"] }), plan("b", "1", { status: "archived", title: "Old" })]
  expect(visiblePlans(plans, "all", "expo").map(item => item.id)).toEqual(["a"])
  expect(visiblePlans(plans, "archived", "").map(item => item.id)).toEqual(["b"])
  expect(visiblePlans(plans, "completed", "")).toEqual([])
})

