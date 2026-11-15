import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { test } from "node:test"
import { apiAccessDenial, isApiPath, isPublicApiRoute, PUBLIC_API_ROUTES } from "../../src/lib/server/api-access"
import { root } from "./vite-ssr"

const DISCOVERY_ROUTE = "src/routes/api/v1/+server.ts"
const OWNER_ENV = { PLAN_MANAGER_OWNER_WORKOS_USER_IDS: "user_owner" }

async function routeFiles(directory = resolve(root, "src/routes/api")): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await routeFiles(path))
    else if (entry.name === "+server.ts") found.push(relative(root, path))
  }
  return found.sort()
}

test("every /api route handler calls an owner or bearer guard", async () => {
  const files = await routeFiles()
  assert.ok(files.length >= 10, "expected to find the API route modules")
  for (const file of files) {
    if (file === DISCOVERY_ROUTE) continue
    const source = await readFile(resolve(root, file), "utf8")
    assert.ok(/requireOwnerResponse\(|requireWriteToken\(/.test(source), `${file} calls neither requireOwnerResponse nor requireWriteToken`)
  }
})

test("every route exempted from the session check has a bearer guard", async () => {
  for (const route of PUBLIC_API_ROUTES) {
    const source = await readFile(resolve(root, route.file), "utf8")
    assert.match(source, new RegExp(`export const ${route.method}\\b`), `${route.file} does not export ${route.method}`)
    if (route.file === DISCOVERY_ROUTE) {
      assert.equal(route.guard, "none")
      continue
    }
    assert.equal(route.guard, "requireWriteToken", `${route.file} is exempt without a bearer guard`)
    assert.match(source, /requireWriteToken\(/, `${route.file} is exempt but never calls requireWriteToken`)
  }
})

test("only GET /api/v1 and PUT /api/v1/plans/<id>/versions are public", () => {
  assert.equal(isPublicApiRoute("GET", "/api/v1"), true)
  assert.equal(isPublicApiRoute("PUT", "/api/v1/plans/plan_1234/versions"), true)
  assert.equal(isPublicApiRoute("PUT", "/api/v1/plans/MQGBEClyjomWNnevlPCgf/versions"), true)

  const denied: [string, string][] = [
    ["GET", "/api/v1/plans/plan_1234/versions"],
    ["POST", "/api/v1/plans/plan_1234/versions"],
    ["POST", "/api/v1"],
    ["HEAD", "/api/v1"],
    ["GET", "/api/v1/"],
    ["GET", "/api/v1/plans"],
    ["PUT", "/api/v1/plans"],
    ["GET", "/api/v1/tokens"],
    ["POST", "/api/v1/tokens"],
    ["GET", "/api/plans"],
    ["GET", "/api"],
    ["put", "/api/v1/plans/plan_1234/versions"],
    ["PUT", "/api/v1/plans/short/versions"],
    ["PUT", "/api/v1/plans/plan_1234/versions/"],
    ["PUT", "/api/v1/plans/plan_1234/versions/extra"],
    ["PUT", "/api/v1/plans/plan_1234/versionsX"],
    ["PUT", "/api/v1/plans/../tokens/versions"],
    ["PUT", "/api/v1/plans/plan_1234/../../tokens"],
    ["PUT", "/api/v1/plans/%2e%2e%2ftokens/versions"],
    ["PUT", "/api/v1/plans/plan_1234/versions/../../../tokens"],
    ["PUT", "/api/v1/plans/plan/1234/versions"],
    ["PUT", "/x/api/v1/plans/plan_1234/versions"],
    ["GET", "/api/v1x"],
  ]
  for (const [method, path] of denied) assert.equal(isPublicApiRoute(method, path), false, `${method} ${path} must not be public`)
})

test("API paths are detected without matching look-alike pages", () => {
  assert.equal(isApiPath("/api"), true)
  assert.equal(isApiPath("/api/plans"), true)
  assert.equal(isApiPath("/apiary"), false)
  assert.equal(isApiPath("/plans/api"), false)
})

test("the hook denies non-public API requests without an owner session", async () => {
  const anonymous = apiAccessDenial("GET", "/api/v1/plans", null, OWNER_ENV)
  assert.equal(anonymous?.status, 401)
  assert.deepEqual(await anonymous?.json(), { error: "Unauthorized" })
  assert.equal(anonymous?.headers.get("content-type"), "application/json")

  const stranger = apiAccessDenial("POST", "/api/v1/tokens", { id: "user_other" }, OWNER_ENV)
  assert.equal(stranger?.status, 403)
  assert.deepEqual(await stranger?.json(), { error: "Forbidden" })

  assert.equal(apiAccessDenial("GET", "/api/plans", { id: "user_owner" }, OWNER_ENV), null)
  assert.equal(apiAccessDenial("GET", "/api/plans", { id: "user_owner" }, {})?.status, 403, "an empty allowlist admits nobody")
})

test("the bearer upload and discovery routes reach their handlers without a session", () => {
  assert.equal(apiAccessDenial("PUT", "/api/v1/plans/plan_1234/versions", null, OWNER_ENV), null)
  assert.equal(apiAccessDenial("GET", "/api/v1", null, OWNER_ENV), null)
  assert.equal(apiAccessDenial("GET", "/api/v1/plans/plan_1234/versions", null, OWNER_ENV)?.status, 401)
})
