import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fetchJsonWithDeadline, getSite, pollForDeviceToken, requestDeviceToken, storeLegacyToken, tokenFromKeychain } from "../../src/cli/commands/remote"

const previousFetch = globalThis.fetch

async function withKeychain<T>(fn: (keychainPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "plan-manager-oauth-test-"))
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    command: process.env.PLAN_MANAGER_SECURITY_COMMAND,
    keychain: process.env.PLAN_MANAGER_TEST_KEYCHAIN,
  }
  const keychainPath = join(root, "keychain")
  const commandPath = join(root, "security")
  try {
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const action = args[0]
const file = process.env.PLAN_MANAGER_TEST_KEYCHAIN
const service = args[args.indexOf('-s') + 1]
if (action === 'add-generic-password') {
  if (args[args.indexOf('-w') + 1]) process.exit(2)
  fs.writeFileSync(file, fs.readFileSync(0, 'utf8').trimEnd())
  fs.writeFileSync(file + '.service', service)
}
else if (action === 'find-generic-password') {
  if (!fs.existsSync(file)) process.exit(1)
  if (fs.existsSync(file + '.service') && fs.readFileSync(file + '.service', 'utf8') !== service) process.exit(44)
  process.stdout.write(fs.readFileSync(file, 'utf8'))
}
else if (action === 'delete-generic-password') fs.rmSync(file, { force: true })
`)
    await chmod(commandPath, 0o700)
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.PLAN_MANAGER_SECURITY_COMMAND = commandPath
    process.env.PLAN_MANAGER_TEST_KEYCHAIN = keychainPath
    return await fn(keychainPath)
  } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries({
      XDG_CONFIG_HOME: previous.config,
      PLAN_MANAGER_SECURITY_COMMAND: previous.command,
      PLAN_MANAGER_TEST_KEYCHAIN: previous.keychain,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

const config = {
  version: 2,
  clientId: "client_cli",
  issuerUrl: "https://auth.example",
  audience: "https://plans.example/api/v1",
  scope: "plans:write",
  deviceAuthorizationEndpoint: "https://auth.example/oauth2/device_authorization",
  tokenEndpoint: "https://auth.example/oauth2/token",
  jwksUrl: "https://auth.example/oauth2/jwks",
} as const

test("WorkOS device login polls safely and stores a versioned rotating credential", async () => {
  await withKeychain(async keychainPath => {
    let polls = 0
    const waits: number[] = []
    let output = ""
    const previousWrite = process.stdout.write
    process.stdout.write = ((value: string | Uint8Array) => { output += String(value); return true }) as typeof process.stdout.write
    globalThis.fetch = async (input, init) => {
      const target = String(input)
      assert.equal(init?.redirect, "error")
      if (target === "https://plans.example/api/v1") return Response.json(config)
      if (target === config.deviceAuthorizationEndpoint) {
        const body = new URLSearchParams(String(init?.body))
        assert.equal(body.get("client_id"), "client_cli")
        assert.equal(body.get("scope"), "openid offline_access plans:write")
        return Response.json({ device_code: "secret-device-code", user_code: "ABCD-EFGH", verification_uri: "https://auth.example/activate", expires_in: 600, interval: 1 })
      }
      if (target === config.tokenEndpoint) {
        const body = new URLSearchParams(String(init?.body))
        assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
        assert.equal(body.get("device_code"), "secret-device-code")
        polls += 1
        if (polls === 1) return Response.json({ error: "slow_down" }, { status: 400 })
        if (polls === 2) return Response.json({ error: "authorization_pending" }, { status: 400 })
        return Response.json({ access_token: "access-token", refresh_token: "refresh-token", token_type: "Bearer", expires_in: 3600 })
      }
      throw new Error(`Unexpected request: ${target}`)
    }
    try {
      await requestDeviceToken({ url: "https://plans.example" }, async ms => { waits.push(ms) })
    } finally {
      process.stdout.write = previousWrite
    }
    assert.match(output, /Code: ABCD-EFGH/)
    assert.match(output, /https:\/\/auth\.example\/activate/)
    assert.doesNotMatch(output, /secret-device-code/)
    assert.deepEqual(waits, [6000, 6000])
    const stored = JSON.parse(await readFile(keychainPath, "utf8"))
    assert.deepEqual({ version: stored.version, provider: stored.provider, siteUrl: stored.siteUrl, clientId: stored.clientId, scope: stored.scope }, {
      version: 2, provider: "workos-cli", siteUrl: "https://plans.example", clientId: "client_cli", scope: "plans:write",
    })
    assert.equal(await readFile(keychainPath + ".service", "utf8"), "plan-manager:site:https://plans.example")
  })
})

test("device denial and cross-origin configuration fail without storing a credential", async () => {
  await withKeychain(async keychainPath => {
    globalThis.fetch = async input => {
      const target = String(input)
      if (target === "https://plans.example/api/v1") return Response.json(config)
      if (target === config.deviceAuthorizationEndpoint) return Response.json({ device_code: "device", user_code: "CODE", verification_uri: "https://auth.example/activate", expires_in: 600 })
      if (target === config.tokenEndpoint) return Response.json({ error: "access_denied", error_description: "User denied access" }, { status: 400 })
      throw new Error(`Unexpected request: ${target}`)
    }
    await assert.rejects(requestDeviceToken({ url: "https://plans.example" }, async () => undefined), /User denied access/)
    await assert.rejects(readFile(keychainPath), { code: "ENOENT" })
    globalThis.fetch = async () => Response.json({ ...config, tokenEndpoint: "https://attacker.example/oauth2/token" })
    await assert.rejects(requestDeviceToken({ url: "https://plans.example" }, async () => undefined), /cross-origin or nonstandard/)
  })
})

test("version 1 Clerk credentials require a new WorkOS login", async () => {
  await withKeychain(async keychainPath => {
    await writeFile(keychainPath, JSON.stringify({ version: 1, accessToken: "old" }))
    await assert.rejects(tokenFromKeychain(), /Stored Clerk credential is obsolete/)
  })
})

test("expired WorkOS access tokens require and save a rotated token pair", async () => {
  await withKeychain(async keychainPath => {
    await writeFile(keychainPath, JSON.stringify({
      version: 2, provider: "workos-cli", siteUrl: "https://plans.example", accessToken: "expired", refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1000, tokenEndpoint: config.tokenEndpoint, clientId: config.clientId,
      issuerUrl: config.issuerUrl, audience: config.audience, scope: config.scope,
    }))
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), config.tokenEndpoint)
      assert.equal(init?.redirect, "error")
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get("grant_type"), "refresh_token")
      assert.equal(body.get("refresh_token"), "old-refresh")
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 })
    }
    assert.equal(await tokenFromKeychain({ url: "https://plans.example" }), "new-access")
    const stored = JSON.parse(await readFile(keychainPath, "utf8"))
    assert.equal(stored.refreshToken, "new-refresh")
    assert.ok(stored.accessTokenExpiresAt > Date.now())
  })
})

test("provider requests time out without waiting for the operating-system network timeout", async () => {
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
  })
  try {
    await assert.rejects(fetchJsonWithDeadline("https://auth.example/oauth2/token", {}, "WorkOS token refresh", 1), /WorkOS token refresh timed out/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("provider response bodies remain inside the same deadline", async () => {
  globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true })
    },
  }))
  try {
    await assert.rejects(fetchJsonWithDeadline("https://auth.example/oauth2/token", {}, "WorkOS token refresh", 1), /WorkOS token refresh timed out/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("provider responses larger than one MiB are rejected before parsing", async () => {
  globalThis.fetch = async () => new Response(`{"padding":"${"x".repeat((1 << 20) + 1)}"}`, {
    headers: { "content-type": "application/json" },
  })
  try {
    await assert.rejects(requestDeviceToken({ url: "https://plans.example" }), /response exceeded 1 MiB/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("successful malformed token responses are rejected and device authorization expires", async () => {
  await withKeychain(async keychainPath => {
    globalThis.fetch = async input => {
      const target = String(input)
      if (target === "https://plans.example/api/v1") return Response.json(config)
      if (target === config.deviceAuthorizationEndpoint) return Response.json({ device_code: "device", user_code: "CODE", verification_uri: "https://auth.example/activate", expires_in: 600 })
      if (target === config.tokenEndpoint) return new Response("not-json", { status: 200 })
      throw new Error(`Unexpected request: ${target}`)
    }
    await assert.rejects(requestDeviceToken({ url: "https://plans.example" }, async () => undefined), /returned invalid JSON/)
    await assert.rejects(readFile(keychainPath), { code: "ENOENT" })

    let now = 1_000
    const previousNow = Date.now
    Date.now = () => now
    globalThis.fetch = async () => Response.json({ error: "authorization_pending" }, { status: 400 })
    try {
      await assert.rejects(pollForDeviceToken(config, { device_code: "device", expires_in: 1, interval: 1 }, async ms => { now += ms }), /device authorization expired/)
    } finally {
      Date.now = previousNow
    }
  })
})

test("credentials are bound to the site origin and never refreshed or sent elsewhere", async () => {
  await withKeychain(async keychainPath => {
    globalThis.fetch = async input => { throw new Error(`Unexpected request: ${String(input)}`) }
    const oauth = {
      version: 2, provider: "workos-cli", accessToken: "expired", refreshToken: "secret-refresh",
      accessTokenExpiresAt: Date.now() - 1000, tokenEndpoint: config.tokenEndpoint, clientId: config.clientId,
      issuerUrl: config.issuerUrl, audience: config.audience, scope: config.scope,
    }
    // Unbound records (pre-namespacing) require a new login.
    await writeFile(keychainPath, JSON.stringify(oauth))
    await assert.rejects(tokenFromKeychain({ url: "https://plans.example" }), /not bound to this site/)
    await writeFile(keychainPath, "pm_abcdefgh_" + "a".repeat(32))
    await assert.rejects(tokenFromKeychain({ url: "https://plans.example" }), /not bound to this site/)
    // A record bound to another origin is rejected before any refresh request.
    await writeFile(keychainPath, JSON.stringify({ ...oauth, siteUrl: "https://attacker.example" }))
    await assert.rejects(tokenFromKeychain({ url: "https://plans.example" }), /not bound to this site/)
    // Legacy pm_ tokens are stored under the site namespace and only returned for that site.
    const token = "pm_abcdefgh_" + "b".repeat(32)
    storeLegacyToken({ url: "https://plans.example" }, token)
    assert.equal(await readFile(keychainPath + ".service", "utf8"), "plan-manager:site:https://plans.example")
    assert.deepEqual(JSON.parse(await readFile(keychainPath, "utf8")), { version: 2, provider: "legacy-token", siteUrl: "https://plans.example", token })
    assert.equal(await tokenFromKeychain({ url: "https://plans.example" }), token)
    await assert.rejects(tokenFromKeychain({ url: "https://other.example" }), /Not signed in/)
  })
})

test("site URL allows plain http only for loopback hosts", () => {
  const previous = process.env.PLAN_MANAGER_URL
  try {
    for (const [value, expected] of [
      ["http://localhost:5173", "http://localhost:5173"],
      ["http://127.0.0.1:5173/", "http://127.0.0.1:5173"],
      ["http://[::1]:5173", "http://[::1]:5173"],
      ["https://Example.com:443", "https://example.com"],
    ]) {
      process.env.PLAN_MANAGER_URL = value
      assert.equal(getSite().url, expected)
    }
    for (const value of ["http://example.com", "http://192.168.1.10:5173", "http://localhost.evil.example", "http://localhost:5173/path"]) {
      process.env.PLAN_MANAGER_URL = value
      assert.throws(() => getSite(), /bare https URL/)
    }
  } finally {
    if (previous === undefined) delete process.env.PLAN_MANAGER_URL
    else process.env.PLAN_MANAGER_URL = previous
  }
})
