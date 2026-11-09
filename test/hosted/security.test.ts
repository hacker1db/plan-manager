import assert from "node:assert/strict"
import { test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { verifyWorkosCliToken } from "../../src/lib/server/workos-cli"
import { HostedConfigurationError, getCliOAuthConfiguration, getHostedEnvironment, getOwnerWorkosUserIds, isAllowedOwner, ownerConfigured, workosCliClaimsCanAccess } from "../../src/lib/server/env"
import { publicPlan } from "../../src/lib/server/api"
import { requirePlanId, requireRevision, sanitizeMarkdown } from "../../src/lib/server/sanitize"
import { generateToken, hashSecret, parseBearer, tokenAuthorizes, verifySecret } from "../../src/lib/server/token"
import { isJsonRequest, isSameOriginRequest } from "../../src/lib/server/security"
import { isPlanStatus } from "../../src/lib/types"

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
  const base = { id: "abcdefgh", secretHash, scopes: ["plans:read"] as ("plans:read")[] }
  assert.equal(await tokenAuthorizes({ ...base, expiresAt: new Date(Date.now() - 1), revokedAt: null }, "A".repeat(43), "pepper", "plans:write"), false)
  assert.equal(await tokenAuthorizes({ ...base, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() }, "A".repeat(43), "pepper", "plans:read"), false)
  assert.equal(await tokenAuthorizes({ ...base, expiresAt: new Date(Date.now() + 60_000), revokedAt: null }, "A".repeat(43), "pepper", "plans:write"), false)
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
