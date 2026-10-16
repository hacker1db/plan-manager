import assert from "node:assert/strict"
import { test } from "node:test"
import { HostedConfigurationError, getCliOAuthConfiguration, getClerkIssuerUrl, getHostedEnvironment, getOwnerClerkUserIds, isAllowedOwner, oauthTokenCanAccess, ownerConfigured } from "../../src/hosted/lib/env"
import { publicPlan } from "../../src/hosted/lib/api"
import { requirePlanId, requireRevision, sanitizeMarkdown } from "../../src/hosted/lib/sanitize"
import { generateToken, hashSecret, parseBearer, tokenAuthorizes, verifySecret } from "../../src/hosted/lib/token"
import { isJsonRequest, isSameOriginRequest } from "../../src/hosted/lib/security"
import { isPlanStatus } from "../../src/lib/types"

test("hosted configuration fails closed when a required key is absent", () => {
  assert.throws(() => getHostedEnvironment({}), HostedConfigurationError)
})

test("hosted configuration accepts only a complete server environment", () => {
  const environment = getHostedEnvironment({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_value",
    CLERK_SECRET_KEY: "sk_test_value",
    PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_owner, user_second, user_owner",
    DATABASE_URL: "postgres://example",
    BLOB_READ_WRITE_TOKEN: "blob_value",
    PLAN_MANAGER_TOKEN_PEPPER: "pepper_value",
  })
  assert.deepEqual(environment.ownerClerkUserIds, ["user_owner", "user_second"])
})

test("owner allowlist supports the legacy single-owner variable during migration", () => {
  assert.deepEqual(getOwnerClerkUserIds({ PLAN_MANAGER_OWNER_CLERK_USER_ID: "user_owner" }), ["user_owner"])
  assert.deepEqual(getOwnerClerkUserIds({ PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_new", PLAN_MANAGER_OWNER_CLERK_USER_ID: "user_old" }), ["user_new"])
  assert.equal(isAllowedOwner("user_new", { PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_new,user_other" }), true)
  assert.equal(isAllowedOwner("user_old", { PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_new,user_other" }), false)
  assert.equal(isAllowedOwner(null, { PLAN_MANAGER_OWNER_CLERK_USER_ID: "user_old" }), false)
  assert.equal(ownerConfigured({ CLERK_SECRET_KEY: "sk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk", PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_one,user_two" }), true)
  assert.equal(ownerConfigured({ CLERK_SECRET_KEY: "sk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk" }), false)
  assert.throws(() => getHostedEnvironment({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_value",
    CLERK_SECRET_KEY: "sk_test_value",
    DATABASE_URL: "postgres://example",
    BLOB_READ_WRITE_TOKEN: "blob_value",
    PLAN_MANAGER_TOKEN_PEPPER: "pepper_value",
  }), HostedConfigurationError)
})

test("CLI OAuth config exposes the Clerk issuer and requires a public client ID", () => {
  const publishableKey = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64url")}`
  assert.equal(getClerkIssuerUrl({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey }), "https://example.clerk.accounts.dev")
  assert.deepEqual(getCliOAuthConfiguration({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey, PLAN_MANAGER_OAUTH_CLIENT_ID: "oauthapp_public" }), {
    clientId: "oauthapp_public",
    issuerUrl: "https://example.clerk.accounts.dev",
  })
  assert.throws(() => getCliOAuthConfiguration({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey }), HostedConfigurationError)
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

test("OAuth credentials require an allowlisted Clerk owner and a token issued to the CLI app", () => {
  const env = { PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_owner,user_second", PLAN_MANAGER_OAUTH_CLIENT_ID: "cli_client" }
  assert.equal(oauthTokenCanAccess("user_owner", "cli_client", ["openid", "offline_access"], env), true)
  assert.equal(oauthTokenCanAccess("user_second", "cli_client", ["openid"], env), true)
  assert.equal(oauthTokenCanAccess("user_other", "cli_client", ["openid"], env), false)
  assert.equal(oauthTokenCanAccess("user_owner", "other_client", ["openid"], env), false)
  assert.equal(oauthTokenCanAccess("user_owner", null, ["openid"], env), false)
  assert.equal(oauthTokenCanAccess("user_owner", "cli_client", ["offline_access"], env), false)
  assert.equal(oauthTokenCanAccess("user_owner", "cli_client", ["openid"], { PLAN_MANAGER_OWNER_CLERK_USER_IDS: "user_owner" }), false)
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
