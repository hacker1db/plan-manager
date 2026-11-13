import { createHash, randomBytes } from "node:crypto"
import { accessTokenExpiry, authorizationCode, authorizationUrl, createPkce, exchangeCode, refreshTokens } from "../src/lib/auth"
import { base64UrlEncode } from "../src/lib/base64"

const redirect = "dev.hacker1db.planmanager://callback"
const crypto = {
  randomBytes: (count: number) => new Uint8Array(randomBytes(count)),
  sha256Base64: async (input: string) => createHash("sha256").update(input).digest("base64"),
}

test("PKCE pair is RFC 7636 S256 with URL-safe verifier, challenge and state", async () => {
  const pkce = await createPkce(crypto)
  expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"))
  expect(pkce.state).toMatch(/^[A-Za-z0-9_-]{22}$/)
})

test("base64url encoding matches Node for every remainder length", () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = new Uint8Array(randomBytes(length))
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
  }
})

test("authorization URL targets WorkOS AuthKit with PKCE S256", () => {
  const url = new URL(authorizationUrl({ clientId: "client_123", redirectUri: redirect, state: "s", challenge: "c" }))
  expect(url.origin + url.pathname).toBe("https://api.workos.com/user_management/authorize")
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "client_123", redirect_uri: redirect, response_type: "code", provider: "authkit", state: "s", code_challenge: "c", code_challenge_method: "S256",
  })
})

test("callback is accepted only for the exact redirect, one matching state, and one code", () => {
  expect(authorizationCode(`${redirect}?code=abc&state=s1`, redirect, "s1")).toBe("abc")
  for (const callback of [
    `${redirect}?code=abc&state=other`,
    `${redirect}?code=abc`,
    `${redirect}?code=abc&state=s1&state=s1`,
    `${redirect}?code=abc&code=def&state=s1`,
    `${redirect}?code=&state=s1`,
    `${redirect}?code=abc&state=s1&error=access_denied`,
    `${redirect}?code=abc&state=s1#frag`,
    `${redirect}/extra?code=abc&state=s1`,
    `evil.example.app://callback?code=abc&state=s1`,
    `dev.hacker1db.planmanager://evil?code=abc&state=s1`,
    `dev.hacker1db.planmanager://user@callback?code=abc&state=s1`,
    `${redirect}?code=%E0%A4%A&state=s1`,
    "not a url",
  ]) expect(authorizationCode(callback, redirect, "s1")).toBeNull()
})

test("access token expiry is read from exp and fails safe to an immediate refresh", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000, sub: "user_owner" })).toString("base64url")
  expect(accessTokenExpiry(`h.${payload}.s`)).toBe(1_800_000_000_000)
  expect(accessTokenExpiry("garbage")).toBe(0)
  expect(accessTokenExpiry(`h.${Buffer.from("{").toString("base64url")}.s`)).toBe(0)
  expect(accessTokenExpiry(`h.${Buffer.from('{"exp":"soon"}').toString("base64url")}.s`)).toBe(0)
})

test("code exchange and refresh send public-client JSON without a secret or cookies", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", user: {} }), { status: 200 })
  }) as unknown as typeof fetch
  await expect(exchangeCode(fetchImpl, { clientId: "client_1", code: "c", verifier: "v" })).resolves.toEqual({ access: "a", refresh: "r" })
  await expect(refreshTokens(fetchImpl, { clientId: "client_1", refresh: "old" })).resolves.toEqual({ access: "a", refresh: "r" })
  expect(calls.map(call => call.url)).toEqual(["https://api.workos.com/user_management/authenticate", "https://api.workos.com/user_management/authenticate"])
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ grant_type: "authorization_code", client_id: "client_1", code: "c", code_verifier: "v" })
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ grant_type: "refresh_token", client_id: "client_1", refresh_token: "old" })
  for (const call of calls) expect(call.init.credentials).toBe("omit")

  const failing = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch
  await expect(refreshTokens(failing, { clientId: "client_1", refresh: "old" })).rejects.toThrow("400")
  const incomplete = (async () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 })) as unknown as typeof fetch
  await expect(exchangeCode(incomplete, { clientId: "client_1", code: "c", verifier: "v" })).rejects.toThrow("incomplete")
})
