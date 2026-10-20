import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { cmdOpen } from "../../src/cli/commands/open"

const BIN = new URL("../../bin/plan", import.meta.url).pathname
const previousFetch = globalThis.fetch

type Environment = { root: string; openedPath: string; keychainPath: string }

const ENV_KEYS = ["XDG_CONFIG_HOME", "PLAN_MANAGER_SECURITY_COMMAND", "PLAN_MANAGER_TEST_KEYCHAIN", "PLAN_MANAGER_URL", "PLAN_BROWSER", "PLAN_TEST_OPENED", "PLAN_HOME", "PLAN_PORT"] as const

async function withEnvironment<T>(fn: (environment: Environment) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "plan-open-test-"))
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const keychainPath = join(root, "keychain")
  const securityPath = join(root, "security")
  const browserPath = join(root, "browser")
  const openedPath = join(root, "opened")
  try {
    await writeFile(securityPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = process.env.PLAN_MANAGER_TEST_KEYCHAIN
if (args[0] === 'add-generic-password') fs.writeFileSync(file, args[args.indexOf('-w') + 1])
else if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(file)) process.exit(1)
  process.stdout.write(fs.readFileSync(file, 'utf8'))
}
else if (args[0] === 'delete-generic-password') fs.rmSync(file, { force: true })
`)
    await chmod(securityPath, 0o700)
    await writeFile(browserPath, `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PLAN_TEST_OPENED, process.argv[2] + '\\n')
`)
    await chmod(browserPath, 0o700)
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.PLAN_MANAGER_SECURITY_COMMAND = securityPath
    process.env.PLAN_MANAGER_TEST_KEYCHAIN = keychainPath
    process.env.PLAN_MANAGER_URL = "https://plans.example"
    process.env.PLAN_BROWSER = browserPath
    process.env.PLAN_TEST_OPENED = openedPath
    return await fn({ root, openedPath, keychainPath })
  } finally {
    globalThis.fetch = previousFetch
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]!
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function storeSignedInCredential(keychainPath: string): Promise<void> {
  await writeFile(keychainPath, JSON.stringify({
    version: 1,
    accessToken: "clerk-access-token",
    refreshToken: "clerk-refresh-token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    tokenEndpoint: "https://clerk.example/oauth/token",
    clientId: "oauthapp_public",
  }))
}

async function captureDependencyFailure(fn: () => Promise<void>): Promise<string> {
  const previousExit = process.exit
  const previousWrite = process.stderr.write
  let output = ""
  process.exit = ((code?: number) => { throw new Error(`process.exit:${code}`) }) as typeof process.exit
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await assert.rejects(fn, /process\.exit:8/)
  } finally {
    process.exit = previousExit
    process.stderr.write = previousWrite
  }
  return output
}

test("bare open launches the hosted site when signed in and reachable", async () => {
  await withEnvironment(async ({ openedPath, keychainPath }) => {
    await storeSignedInCredential(keychainPath)
    const requested: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return Response.json({ clientId: "oauthapp_public", issuerUrl: "https://clerk.example" })
    }) as typeof fetch
    await cmdOpen([], {})
    assert.deepEqual(requested, ["https://plans.example/api/v1"])
    assert.equal(await readFile(openedPath, "utf8"), "https://plans.example\n")
  })
})

test("open --localhost reuses a running local dashboard and opens its URL", async () => {
  await withEnvironment(async ({ root, openedPath }) => {
    const planHome = join(root, "plans")
    await mkdir(planHome, { recursive: true })
    const server = createServer((request, response) => {
      if (request.url === "/_health") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ service: "plan-manager", version: 1, status: "ok", planHome }))
      } else {
        response.writeHead(404).end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    try {
      process.env.PLAN_HOME = planHome
      process.env.PLAN_PORT = String(address.port)
      globalThis.fetch = (async () => { throw new Error("hosted site must not be contacted with --localhost") }) as typeof fetch
      await cmdOpen([], { localhost: true })
      assert.equal(await readFile(openedPath, "utf8"), `http://plans.localhost:${address.port}\n`)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

test("bare open fails with guidance when signed out instead of falling back", async () => {
  await withEnvironment(async ({ root, openedPath }) => {
    const result = spawnSync(process.execPath, [BIN], {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        PLAN_MANAGER_URL: "https://plans.example",
        PLAN_TEST_OPENED: openedPath,
      },
    })
    assert.equal(result.status, 8, result.stderr)
    assert.match(result.stderr, /Not signed in to https:\/\/plans\.example/)
    assert.match(result.stderr, /plan auth login/)
    assert.match(result.stderr, /plan --localhost/)
    await assert.rejects(readFile(openedPath, "utf8"), { code: "ENOENT" })
  })
})

test("bare open reports credential refresh connectivity failures separately from signed-out state", async () => {
  await withEnvironment(async ({ keychainPath }) => {
    await writeFile(keychainPath, JSON.stringify({
      version: 1,
      accessToken: "expired-access-token",
      refreshToken: "clerk-refresh-token",
      accessTokenExpiresAt: Date.now() - 1000,
      tokenEndpoint: "https://clerk.example/oauth/token",
      clientId: "oauthapp_public",
    }))
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal)
      throw new TypeError("network unavailable")
    }) as typeof fetch
    const stderr = await captureDependencyFailure(() => cmdOpen([], {}))
    assert.match(stderr, /Cannot refresh credentials for https:\/\/plans\.example/)
    assert.doesNotMatch(stderr, /Not signed in/)
  })
})

test("bare open rejects unsuccessful hosted availability responses", async () => {
  await withEnvironment(async ({ openedPath, keychainPath }) => {
    await storeSignedInCredential(keychainPath)
    globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch
    const stderr = await captureDependencyFailure(() => cmdOpen([], {}))
    assert.match(stderr, /Cannot reach https:\/\/plans\.example/)
    await assert.rejects(readFile(openedPath, "utf8"), { code: "ENOENT" })
  })
})
