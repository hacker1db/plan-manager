import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import { root } from "./vite-ssr"

const script = resolve(root, "scripts/check-hosted-env.mjs")

// Obvious placeholders only; the assertions below prove none of them is ever echoed.
const PLACEHOLDERS = {
  WORKOS_CLIENT_ID: "placeholder-client-id",
  WORKOS_API_KEY: "placeholder-api-key",
  WORKOS_COOKIE_PASSWORD: "placeholder-cookie-password-0123456789",
  WORKOS_REDIRECT_URI: "https://plans.example/callback",
  PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "placeholder-owner",
  PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: "https://auth.example",
  PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: "placeholder-cli-client",
  PLAN_MANAGER_WORKOS_CLI_AUDIENCE: "placeholder-audience",
  DATABASE_URL: "postgres://placeholder-database",
  BLOB_READ_WRITE_TOKEN: "placeholder-blob-token",
  PLAN_MANAGER_TOKEN_PEPPER: "placeholder-pepper",
}

function run(env: Record<string, string>) {
  // Start from an empty environment (plus PATH for node) so the developer's shell cannot leak in.
  const result = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function assertNoValues(output: string) {
  for (const [key, value] of Object.entries(PLACEHOLDERS)) assert.equal(output.includes(value), false, `${key} value leaked into output`)
}

test("production build fails and lists every missing variable name", () => {
  const { status, output } = run({ VERCEL_ENV: "production" })
  assert.notEqual(status, 0)
  for (const key of Object.keys(PLACEHOLDERS)) assert.match(output, new RegExp(`\\b${key}\\b`))
})

test("production build passes with a complete placeholder environment and prints no values", () => {
  const { status, output } = run({ VERCEL_ENV: "production", ...PLACEHOLDERS })
  assert.equal(status, 0, output)
  assertNoValues(output)
})

test("production build rejects a short cookie password and a blank owner list without echoing values", () => {
  const { status, output } = run({ VERCEL_ENV: "production", ...PLACEHOLDERS, WORKOS_COOKIE_PASSWORD: "placeholder-short", PLAN_MANAGER_OWNER_WORKOS_USER_IDS: " , " })
  assert.notEqual(status, 0)
  assert.match(output, /WORKOS_COOKIE_PASSWORD/)
  assert.match(output, /PLAN_MANAGER_OWNER_WORKOS_USER_IDS/)
  assert.doesNotMatch(output, /DATABASE_URL/)
  assert.equal(output.includes("placeholder-short"), false)
  assertNoValues(output)
})

test("the guard does nothing outside Vercel production", () => {
  assert.equal(run({}).status, 0)
  assert.equal(run({ VERCEL_ENV: "preview" }).status, 0)
  assert.equal(run({ VERCEL_ENV: "development" }).status, 0)
})

// Regression: these four were missing or invalid in a failed production deploy. Each alone must fail the build.
for (const key of ["WORKOS_API_KEY", "PLAN_MANAGER_OWNER_WORKOS_USER_IDS", "PLAN_MANAGER_WORKOS_CLI_CLIENT_ID", "PLAN_MANAGER_WORKOS_CLI_AUDIENCE"]) {
  for (const [label, value] of [["missing", undefined], ["blank", "   "]] as const) {
    test(`production build fails when ${key} is ${label}, naming only that key`, () => {
      const env: Record<string, string> = { VERCEL_ENV: "production", ...PLACEHOLDERS }
      if (value === undefined) delete env[key]
      else env[key] = value
      const { status, output } = run(env)
      assert.notEqual(status, 0)
      assert.match(output, new RegExp(`- ${key}\\b`))
      assert.equal((output.match(/^ {2}- /gm) ?? []).length, 1, output)
      assertNoValues(output)
    })
  }
}

// Contract: .env.example (which the CI production build reads) must list every key the guard requires,
// so a new required key cannot reach main without the CI fixture, docs, and operators knowing about it.
test(".env.example lists every variable the production guard requires", () => {
  const example = readFileSync(resolve(root, ".env.example"), "utf8")
  const listed = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(match => match[1]))
  const { output } = run({ VERCEL_ENV: "production" })
  const required = [...output.matchAll(/^ {2}- ([A-Z0-9_]+)$/gm)].map(match => match[1])
  assert.ok(required.length > 0, output)
  for (const key of required) assert.ok(listed.has(key), `${key} is required in production but missing from .env.example`)
})
