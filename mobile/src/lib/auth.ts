import { base64ToBase64Url, base64UrlDecode, base64UrlEncode } from "./base64"
import { encodeQuery, parseUrl, queryParams } from "./url"

// WorkOS public-client (PKCE) endpoints, matching workos-ios 0.9.0 PublicClient.
export const WORKOS_API = "https://api.workos.com"

export type Tokens = { access: string; refresh: string }
export type CryptoProvider = {
  randomBytes: (count: number) => Uint8Array
  sha256Base64: (input: string) => Promise<string>
}

export async function createPkce(crypto: CryptoProvider): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64UrlEncode(crypto.randomBytes(32))
  const challenge = base64ToBase64Url(await crypto.sha256Base64(verifier))
  return { verifier, challenge, state: base64UrlEncode(crypto.randomBytes(16)) }
}

export function authorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  return `${WORKOS_API}/user_management/authorize?${encodeQuery({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    provider: "authkit",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  })}`
}

/** Returns the authorization code only for an exact callback with one matching state and no error. */
export function authorizationCode(callback: string, redirectUri: string, state: string): string | null {
  const actual = parseUrl(callback)
  const expected = parseUrl(redirectUri)
  if (!actual || !expected || actual.scheme !== expected.scheme || actual.authority !== expected.authority || actual.path !== expected.path || actual.fragment !== null) return null
  if (actual.authority.includes("@")) return null
  let params: [string, string][]
  try { params = queryParams(actual.query) } catch { return null }
  const values = (name: string) => params.filter(([key]) => key === name).map(([, value]) => value)
  const states = values("state")
  const codes = values("code")
  if (states.length !== 1 || states[0] !== state || values("error").length > 0 || codes.length !== 1 || !codes[0]) return null
  return codes[0]
}

/** Reads `exp` only to schedule refresh; authorization is decided exclusively by the server. */
export function accessTokenExpiry(jwt: string): number {
  const parts = jwt.split(".")
  if (parts.length !== 3) return 0
  const payload = base64UrlDecode(parts[1])
  if (!payload) return 0
  try {
    const exp = (JSON.parse(payload) as { exp?: unknown }).exp
    return typeof exp === "number" ? exp * 1000 : 0
  } catch { return 0 }
}

export class AuthError extends Error {}

async function authenticate(fetchImpl: typeof fetch, body: Record<string, string>): Promise<Tokens> {
  let response: Response
  try {
    response = await fetchImpl(`${WORKOS_API}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    })
  } catch { throw new AuthError("Unable to reach WorkOS") }
  if (!response.ok) throw new AuthError(`WorkOS authentication failed (${response.status})`)
  const result = (await response.json()) as { access_token?: unknown; refresh_token?: unknown }
  if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string") throw new AuthError("WorkOS returned an incomplete session")
  return { access: result.access_token, refresh: result.refresh_token }
}

export function exchangeCode(fetchImpl: typeof fetch, input: { clientId: string; code: string; verifier: string }): Promise<Tokens> {
  return authenticate(fetchImpl, { grant_type: "authorization_code", client_id: input.clientId, code: input.code, code_verifier: input.verifier })
}

/** WorkOS rotates refresh tokens: persist the returned pair in place of the old one. */
export function refreshTokens(fetchImpl: typeof fetch, input: { clientId: string; refresh: string }): Promise<Tokens> {
  return authenticate(fetchImpl, { grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refresh })
}
