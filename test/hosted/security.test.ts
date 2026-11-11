import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { verifyWorkosCliToken } from "../../src/lib/server/workos-cli"
import { HostedConfigurationError, getCliOAuthConfiguration, getHostedEnvironment, getOwnerWorkosUserIds, isAllowedOwner, ownerConfigured, workosCliClaimsCanAccess } from "../../src/lib/server/env"
import { apiError, publicPlan } from "../../src/lib/server/api"
import { requireJsonObject, requirePlanId, requireRevision, safeTags, safeText, sanitizeMarkdown, ValidationError } from "../../src/lib/server/sanitize"
import { generateToken, hashSecret, isPlanScope, MAX_TOKEN_LIFETIME_MS, parseBearer, parseTokenRequest, tokenAuthorizes, tokenSummaryFromRow, verifySecret } from "../../src/lib/server/token"
import { migrationFiles, migrationStatements } from "../../scripts/migrate-hosted"
import { isJsonRequest, isSameOriginRequest } from "../../src/lib/server/security"
import { isPlanStatus } from "../../src/lib/types"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { CSP_DIRECTIVES, FALLBACK_CSP } from "../../src/lib/server/csp"
import { securityHeaders, withSecurityHeaders } from "../../src/lib/server/headers"
import { renderPlanHtml } from "../../src/lib/server/plan-markdown"
import { closeViteServer, load, root } from "./vite-ssr"

after(closeViteServer)

test("hosted configuration fails closed when a required key is absent", () => {
  assert.throws(() => getHostedEnvironment({}), HostedConfigurationError)
})

const completeEnvironment = {
  WORKOS_CLIENT_ID: "client_web",
  WORKOS_API_KEY: "sk_test_example",
  WORKOS_COOKIE_PASSWORD: "fixture-only-".repeat(4),
  WORKOS_REDIRECT_URI: "https://plans.example/callback",
  PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner, user_second, user_owner",
  DATABASE_URL: "postgres://example",
  BLOB_READ_WRITE_TOKEN: "blob_value",
  PLAN_MANAGER_TOKEN_PEPPER: "pepper_value",
}

const cliEnvironment = {
  PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner,user_second",
  PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: "https://auth.example",
  PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: "client_cli",
  PLAN_MANAGER_WORKOS_CLI_AUDIENCE: "https://plans.example/api/v1",
}

test("hosted configuration accepts only a complete WorkOS server environment", () => {
  const environment = getHostedEnvironment({
    ...completeEnvironment,
    DATABASE_URL: "postgres://example",
    BLOB_READ_WRITE_TOKEN: "blob_value",
    PLAN_MANAGER_TOKEN_PEPPER: "pepper_value",
  })
  assert.deepEqual(environment.ownerWorkosUserIds, ["user_owner", "user_second"])
})

test("owner authorization uses only the fail-closed WorkOS allowlist", () => {
  assert.deepEqual(getOwnerWorkosUserIds({ PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_new,user_other,user_new" }), ["user_new", "user_other"])
  assert.deepEqual(getOwnerWorkosUserIds({ PLAN_MANAGER_OWNER_CLERK_USER_IDS: "legacy_owner" }), [])
  assert.equal(isAllowedOwner("user_new", { PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_new,user_other" }), true)
  assert.equal(isAllowedOwner("user_old", { PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_new,user_other" }), false)
  assert.equal(isAllowedOwner(null, { PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_old" }), false)
  assert.equal(ownerConfigured(completeEnvironment), true)
  assert.equal(ownerConfigured({ ...completeEnvironment, PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "" }), false)
  assert.throws(() => getHostedEnvironment({
    ...completeEnvironment,
    PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "",
    DATABASE_URL: "postgres://example",
    BLOB_READ_WRITE_TOKEN: "blob_value",
    PLAN_MANAGER_TOKEN_PEPPER: "pepper_value",
  }), HostedConfigurationError)
})

test("CLI config exposes only pinned WorkOS Connect endpoints and identifiers", () => {
  assert.deepEqual(getCliOAuthConfiguration(cliEnvironment), {
    version: 2,
    clientId: "client_cli",
    issuerUrl: "https://auth.example",
    audience: "https://plans.example/api/v1",
    scope: "plans:write",
    deviceAuthorizationEndpoint: "https://auth.example/oauth2/device_authorization",
    tokenEndpoint: "https://auth.example/oauth2/token",
    jwksUrl: "https://auth.example/oauth2/jwks",
  })
  assert.throws(() => getCliOAuthConfiguration({ ...cliEnvironment, PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: "http://auth.example" }), HostedConfigurationError)
  assert.throws(() => getCliOAuthConfiguration({ ...cliEnvironment, PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: "" }), HostedConfigurationError)
})

test("token verifier accepts the generated bearer only for the correct secret", async () => {
  const generated = generateToken("abcdefgh")
  const record = { id: generated.id, scopes: ["plans:write"] as const, expiresAt: new Date(Date.now() + 60_000), revokedAt: null, secretHash: await hashSecret(generated.secret, "pepper") }
  assert.deepEqual(parseBearer(`Bearer ${generated.bearer}`), { id: generated.id, secret: generated.secret })
  assert.equal(await verifySecret(generated.secret, "pepper", record.secretHash), true)
  assert.equal(await tokenAuthorizes(record, generated.secret, "pepper", "plans:write"), true)
  assert.equal(await tokenAuthorizes(record, "wrong-secret", "pepper", "plans:write"), false)
})

test("expired, revoked, and insufficient-scope credentials cannot write", async () => {
  const secretHash = await hashSecret("A".repeat(43), "pepper")
  const write = { id: "abcdefgh", secretHash, scopes: ["plans:write"] as const }
  // A legacy database row may still carry the retired plans:read scope; it never grants writes.
  const legacyReadOnly = { id: "abcdefgh", secretHash, scopes: ["plans:read"] as unknown as ["plans:write"] }
  assert.equal(await tokenAuthorizes({ ...write, expiresAt: new Date(Date.now() - 1), revokedAt: null }, "A".repeat(43), "pepper", "plans:write"), false)
  assert.equal(await tokenAuthorizes({ ...write, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() }, "A".repeat(43), "pepper", "plans:write"), false)
  assert.equal(await tokenAuthorizes({ ...legacyReadOnly, expiresAt: new Date(Date.now() + 60_000), revokedAt: null }, "A".repeat(43), "pepper", "plans:write"), false)
})

test("CLI claims require the allowlisted owner, exact client, and write scope", () => {
  assert.equal(workosCliClaimsCanAccess("user_owner", "client_cli", "openid offline_access plans:write", cliEnvironment), true)
  assert.equal(workosCliClaimsCanAccess("user_other", "client_cli", "plans:write", cliEnvironment), false)
  assert.equal(workosCliClaimsCanAccess("user_owner", "other_client", "plans:write", cliEnvironment), false)
  assert.equal(workosCliClaimsCanAccess("user_owner", "client_cli", "openid offline_access", cliEnvironment), false)
  assert.equal(workosCliClaimsCanAccess(null, "client_cli", "plans:write", cliEnvironment), false)
})

test("CLI JWT verification rejects the wrong issuer, audience, algorithm, client, and scope", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const publicJwk = await exportJWK(publicKey)
  const getKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test", alg: "RS256", use: "sig" }] })
  const sign = (claims: Record<string, unknown> = {}, issuer = cliEnvironment.PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN, audience = cliEnvironment.PLAN_MANAGER_WORKOS_CLI_AUDIENCE) =>
    new SignJWT({ client_id: "client_cli", scope: "openid offline_access plans:write", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("user_owner")
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

  assert.equal(await verifyWorkosCliToken(await sign(), cliEnvironment, getKey), true)
  assert.equal(await verifyWorkosCliToken(await sign({ client_id: "other" }), cliEnvironment, getKey), false)
  assert.equal(await verifyWorkosCliToken(await sign({ scope: "openid" }), cliEnvironment, getKey), false)
  await assert.rejects(verifyWorkosCliToken(await sign({}, "https://wrong.example"), cliEnvironment, getKey))
  await assert.rejects(verifyWorkosCliToken(await sign({}, cliEnvironment.PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN, "wrong-audience"), cliEnvironment, getKey))

  const symmetric = new TextEncoder().encode("0123456789abcdef0123456789abcdef")
  const wrongAlgorithm = await new SignJWT({ client_id: "client_cli", scope: "plans:write" })
    .setProtectedHeader({ alg: "HS256", kid: "test" })
    .setSubject("user_owner")
    .setIssuer(cliEnvironment.PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN)
    .setAudience(cliEnvironment.PLAN_MANAGER_WORKOS_CLI_AUDIENCE)
    .setExpirationTime("5m")
    .sign(symmetric)
  await assert.rejects(verifyWorkosCliToken(wrongAlgorithm, cliEnvironment, getKey))
})

test("CLI JWT verification rejects tokens without exp or sub", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const publicJwk = await exportJWK(publicKey)
  const getKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test", alg: "RS256", use: "sig" }] })
  const base = () => new SignJWT({ client_id: "client_cli", scope: "openid offline_access plans:write" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(cliEnvironment.PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN)
    .setAudience(cliEnvironment.PLAN_MANAGER_WORKOS_CLI_AUDIENCE)
    .setIssuedAt()
  const noExp = await base().setSubject("user_owner").sign(privateKey)
  await assert.rejects(verifyWorkosCliToken(noExp, cliEnvironment, getKey), /"exp" claim/)
  const noSub = await base().setExpirationTime("5m").sign(privateKey)
  await assert.rejects(verifyWorkosCliToken(noSub, cliEnvironment, getKey), /"sub" claim/)
})

test("plan IDs, revisions, and markdown reject malformed input", () => {
  assert.equal(requirePlanId("plan_1234"), "plan_1234")
  assert.throws(() => requirePlanId("../../plans"))
  assert.equal(requireRevision("a".repeat(64)), "a".repeat(64))
  assert.throws(() => requireRevision("not-a-revision"))
  assert.equal(sanitizeMarkdown("# Plan\r\n"), "# Plan\n")
  assert.throws(() => sanitizeMarkdown("\u0000"))
})

test("dashboard API plan records never expose hosted storage object keys", () => {
  const value = { id: "plan_1234", title: "Plan", objectKey: "private/plans/plan_1234/revision.md" }
  assert.deepEqual(publicPlan(value), { id: value.id, title: value.title })
})

test("dashboard mutations require an exact same-origin Origin header", () => {
  const makeRequest = (origin?: string) => new Request("https://plans.example/api/plans/plan_1234/status", {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
  })
  assert.equal(isSameOriginRequest(makeRequest("https://plans.example")), true)
  assert.equal(isSameOriginRequest(makeRequest("https://attacker.example")), false)
  assert.equal(isSameOriginRequest(makeRequest()), false)
})

test("token creation accepts only JSON requests", () => {
  const request = (contentType?: string) => new Request("https://plans.example/api/v1/tokens", {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
  })
  assert.equal(isJsonRequest(request("application/json")), true)
  assert.equal(isJsonRequest(request("application/json; charset=utf-8")), true)
  assert.equal(isJsonRequest(request("text/plain")), false)
  assert.equal(isJsonRequest(request()), false)
})

test("all supported plan statuses are accepted and unknown statuses are rejected", () => {
  for (const status of ["active", "completed", "archived"] as const) assert.equal(isPlanStatus(status), true)
  assert.equal(isPlanStatus("in-progress"), false)
  assert.equal(isPlanStatus(null), false)
})

// Builds the header exactly as SvelteKit does at runtime, from the directives vite.config.ts passes.
async function generatedPageCsp(): Promise<string> {
  ;(globalThis as Record<string, unknown>).__SVELTEKIT_DEV__ = false
  const { Csp } = await import(pathToFileURL(resolve(root, "node_modules/@sveltejs/kit/src/runtime/server/page/csp.js")).href)
  const csp = new Csp({ mode: "auto", directives: structuredClone(CSP_DIRECTIVES), reportOnly: {} }, { prerender: false })
  await csp.add_script("/* SvelteKit hydration */")
  return csp.csp_provider.get_header()
}

function directive(header: string, name: string): string | undefined {
  return header.split(";").map(part => part.trim()).find(part => part === name || part.startsWith(`${name} `))
}

test("page CSP restricts scripts to self plus a nonce and keeps the anti-framing directives", async () => {
  const config = await readFile(resolve(root, "vite.config.ts"), "utf8")
  assert.match(config, /csp:\s*\{\s*mode:\s*"auto",\s*directives:[^}]*CSP_DIRECTIVES/, "vite.config.ts must pass CSP_DIRECTIVES to SvelteKit")

  const header = await generatedPageCsp()
  assert.equal(directive(header, "default-src"), "default-src 'self'")
  const scriptSrc = directive(header, "script-src")
  assert.ok(scriptSrc, "script-src is present")
  assert.match(scriptSrc, /^script-src 'self' 'nonce-[A-Za-z0-9+/=]+'$/)
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|strict-dynamic/)
  assert.equal(directive(header, "script-src-elem"), undefined, "no script-src-elem may loosen script-src")
  assert.equal(directive(header, "script-src-attr"), undefined)
  assert.doesNotMatch(header, /unsafe-eval/)
  // Inline CSS is allowed only where Mermaid needs it (see csp.ts); style-src itself stays 'self'.
  assert.equal(directive(header, "style-src"), "style-src 'self'")
  assert.equal(directive(header, "style-src-elem"), "style-src-elem 'self' 'unsafe-inline'")
  assert.equal(directive(header, "style-src-attr"), "style-src-attr 'unsafe-inline'")
  assert.equal(directive(header, "img-src"), "img-src 'self' data:")
  assert.equal(directive(header, "connect-src"), "connect-src 'self'")
  assert.equal(directive(header, "font-src"), "font-src 'self'")
  assert.equal(directive(header, "frame-ancestors"), "frame-ancestors 'none'")
  assert.equal(directive(header, "object-src"), "object-src 'none'")
  assert.equal(directive(header, "base-uri"), "base-uri 'none'")
  assert.equal(directive(header, "form-action"), "form-action 'self' https://api.workos.com")
})

test("every response gets the hardening headers and non-page responses get a deny-all CSP", () => {
  const api = withSecurityHeaders(new Response("{}", { headers: { "Content-Type": "application/json" } }))
  assert.equal(api.headers.get("Content-Security-Policy"), FALLBACK_CSP)
  assert.equal(FALLBACK_CSP, "default-src 'none'; frame-ancestors 'none'")
  assert.equal(api.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(), payment=()")
  assert.equal(api.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
  assert.equal(api.headers.get("Strict-Transport-Security"), "max-age=63072000; includeSubDomains")
  assert.equal(api.headers.get("X-Frame-Options"), "DENY")
  assert.equal(api.headers.get("X-Content-Type-Options"), "nosniff")
  assert.equal(api.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
  assert.equal("Content-Security-Policy" in securityHeaders, false, "the page CSP must not be sent twice")

  // A SvelteKit-rendered page keeps its own nonce-based policy.
  const page = withSecurityHeaders(new Response("<!doctype html>", { headers: { "Content-Security-Policy": "default-src 'self'" } }))
  assert.equal(page.headers.get("Content-Security-Policy"), "default-src 'self'")

  // Immutable redirect responses are copied, not dropped.
  const redirect = withSecurityHeaders(Response.redirect("https://plans.example/sign-in", 303))
  assert.equal(redirect.status, 303)
  assert.equal(redirect.headers.get("Content-Security-Policy"), FALLBACK_CSP)
})

test("rendered plans use classes instead of inline style attributes the CSP would block", async () => {
  const markdown = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n"
  const html = renderPlanHtml(markdown)
  assert.doesNotMatch(html, /style=/)
  assert.match(html, /class="pm-align-center"/)
  assert.match(html, /class="pm-align-right"/)
  const mdx = renderPlanHtml(`---\nformat: mdx\n---\n\n${markdown}`)
  assert.doesNotMatch(mdx, /style=/)
  assert.match(mdx, /pm-align-center/)
  const shell = await readFile(resolve(root, "src/app.html"), "utf8")
  assert.doesNotMatch(shell, /style=/)
})

test("validation failures map to 400 and other errors stay a generic 500", async () => {
  const invalid = apiError(new ValidationError("Invalid plan id"))
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: "Invalid plan id" })
  const failure = apiError(new Error("database exploded: secret detail"))
  assert.equal(failure.status, 500)
  assert.deepEqual(await failure.json(), { error: "Request failed" })
  assert.equal(apiError(new SyntaxError("Unexpected token")).status, 400)
})

test("every input validator throws ValidationError without echoing the input", () => {
  const hostile = "<script>alert(1)</script>"
  const cases: (() => unknown)[] = [
    () => requirePlanId(hostile),
    () => requireRevision(hostile),
    () => sanitizeMarkdown(42),
    () => sanitizeMarkdown(`${hostile}\u0000`),
    () => safeText(`${hostile}\u0001`, "title", 256),
    () => safeTags(hostile),
    () => requireJsonObject(hostile),
  ]
  for (const run of cases) {
    assert.throws(run, (error: unknown) => error instanceof ValidationError && !error.message.includes(hostile))
  }
})

test("API bodies must be plain JSON objects", () => {
  for (const body of [null, [], [1, 2], 42, "text", true]) assert.throws(() => requireJsonObject(body), ValidationError)
  assert.deepEqual(requireJsonObject({ id: "plan_1234" }), { id: "plan_1234" })
  for (const body of [null, [], 42, "text"]) assert.throws(() => parseTokenRequest(body), ValidationError)
  assert.throws(() => parseTokenRequest({ scopes: "plans:write", expiresAt: new Date(Date.now() + 60_000).toISOString() }), ValidationError)
  assert.throws(() => parseTokenRequest({ scopes: ["plans:write"], expiresAt: "soon" }), ValidationError)
})

test("the upload route rejects non-object bodies before reading fields", async () => {
  const source = await readFile(resolve(root, "src/routes/api/v1/plans/[id]/versions/+server.ts"), "utf8")
  assert.match(source, /requireJsonObject\(await request\.json\(\)\)/)
})

test("token creation answers 400 for null and array bodies", async () => {
  ;(await load("/src/lib/server/env.ts")).setEnvironmentSource({ ...completeEnvironment, PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner" })
  const { POST } = await load("/src/routes/api/v1/tokens/+server.ts")
  for (const body of ["null", "[]", "[{\"scopes\":[\"plans:write\"]}]", "7"]) {
    const request = new Request("https://plans.example/api/v1/tokens", { method: "POST", headers: { Origin: "https://plans.example", "Content-Type": "application/json" }, body })
    const response = await POST({ request, locals: { auth: { user: { id: "user_owner" } } } })
    assert.equal(response.status, 400, `body ${body}`)
    assert.deepEqual(await response.json(), { error: "Request body must be a JSON object" })
  }
})

const DAY_MS = 24 * 60 * 60 * 1000

test("token lifetime is capped at 90 days", () => {
  const now = new Date("2026-11-11T12:00:00.000Z")
  const at = (offset: number) => new Date(now.valueOf() + offset).toISOString()
  assert.equal(MAX_TOKEN_LIFETIME_MS, 90 * DAY_MS)
  assert.equal(parseTokenRequest({ scopes: ["plans:write"], expiresAt: at(89 * DAY_MS) }, now).expiresAt.toISOString(), at(89 * DAY_MS))
  assert.equal(parseTokenRequest({ scopes: ["plans:write"], expiresAt: at(90 * DAY_MS) }, now).expiresAt.toISOString(), at(90 * DAY_MS))
  for (const expiresAt of [at(91 * DAY_MS), at(90 * DAY_MS + 1), "9999-12-31T23:59:59.000Z"]) {
    assert.throws(() => parseTokenRequest({ scopes: ["plans:write"], expiresAt }, now), (error: unknown) => error instanceof ValidationError && /90 days/.test(error.message))
  }
})

test("the unused plans:read scope can no longer be minted", () => {
  assert.equal(isPlanScope("plans:write"), true)
  assert.equal(isPlanScope("plans:read"), false)
  assert.throws(() => parseTokenRequest({ scopes: ["plans:read"], expiresAt: new Date(Date.now() + DAY_MS).toISOString() }), ValidationError)
})

test("the token listing never exposes the secret hash", () => {
  const row = { id: "abcdefgh", secret_hash: "salt.hash-placeholder", secretHash: "salt.hash-placeholder", scopes: ["plans:write" as const], expires_at: "2026-12-01T00:00:00.000Z", revoked_at: null, last_used_at: "2026-11-10T00:00:00.000Z", created_at: null }
  const summary = tokenSummaryFromRow(row)
  assert.deepEqual(Object.keys(summary).sort(), ["createdAt", "expiresAt", "id", "lastUsedAt", "revokedAt", "scopes"])
  assert.equal("secret_hash" in summary, false)
  assert.equal("secretHash" in summary, false)
  assert.equal(JSON.stringify(summary).includes("hash-placeholder"), false)
  assert.equal(summary.lastUsedAt?.toISOString(), "2026-11-10T00:00:00.000Z")
  assert.equal(summary.createdAt, null)
})

test("token routes stay owner-only: listing and creation reject anonymous and non-owner sessions", async () => {
  ;(await load("/src/lib/server/env.ts")).setEnvironmentSource({ ...completeEnvironment, PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner" })
  const { GET } = await load("/src/routes/api/v1/tokens/+server.ts")
  assert.equal((await GET({ locals: { auth: { user: null } } })).status, 401)
  assert.equal((await GET({ locals: { auth: { user: { id: "user_other" } } } })).status, 403)
})

test("hosted migrations run in order and 002 is additive and idempotent", async () => {
  const files = (await migrationFiles(resolve(root, "src/lib/server/migrations"))).map(file => file.split("/").pop())
  assert.deepEqual(files, ["001_initial.sql", "002_token_last_used.sql"])
  const statements = migrationStatements(await readFile(resolve(root, "src/lib/server/migrations/002_token_last_used.sql"), "utf8"))
  assert.deepEqual(statements, [
    "ALTER TABLE cli_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ",
    "ALTER TABLE cli_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ",
  ])
})
