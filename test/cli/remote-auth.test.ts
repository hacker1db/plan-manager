import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { cmdAuth, tokenFromKeychain } from "../../src/cli/commands/remote"

const previousFetch = globalThis.fetch

async function withKeychain<T>(fn: (keychainPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "plan-manager-oauth-test-"))
  const oldConfig = process.env.XDG_CONFIG_HOME
  const oldCommand = process.env.PLAN_MANAGER_SECURITY_COMMAND
  const oldKeychain = process.env.PLAN_MANAGER_TEST_KEYCHAIN
  const oldUrl = process.env.PLAN_MANAGER_URL
  const keychainPath = join(root, "keychain")
  const commandPath = join(root, "security")
  try {
    await writeFile(commandPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const action = args[0]
const file = process.env.PLAN_MANAGER_TEST_KEYCHAIN
if (action === 'add-generic-password') fs.writeFileSync(file, args[args.indexOf('-w') + 1])
else if (action === 'find-generic-password') {
  if (!fs.existsSync(file)) process.exit(1)
  process.stdout.write(fs.readFileSync(file, 'utf8'))
}
else if (action === 'delete-generic-password') fs.rmSync(file, { force: true })
`)
    await chmod(commandPath, 0o700)
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.PLAN_MANAGER_SECURITY_COMMAND = commandPath
    process.env.PLAN_MANAGER_TEST_KEYCHAIN = keychainPath
    process.env.PLAN_MANAGER_URL = "https://plans.example"
    return await fn(keychainPath)
  } finally {
    globalThis.fetch = previousFetch
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = oldConfig
    if (oldCommand === undefined) delete process.env.PLAN_MANAGER_SECURITY_COMMAND
    else process.env.PLAN_MANAGER_SECURITY_COMMAND = oldCommand
    if (oldKeychain === undefined) delete process.env.PLAN_MANAGER_TEST_KEYCHAIN
    else process.env.PLAN_MANAGER_TEST_KEYCHAIN = oldKeychain
    if (oldUrl === undefined) delete process.env.PLAN_MANAGER_URL
    else process.env.PLAN_MANAGER_URL = oldUrl
    await rm(root, { recursive: true, force: true })
  }
}

test("Clerk device login polls until approved and stores the OAuth pair in Keychain", async () => {
  await withKeychain(async keychainPath => {
    let polls = 0
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === "https://plans.example/api/v1") return Response.json({ clientId: "oauthapp_public", issuerUrl: "https://clerk.example" })
      if (url === "https://clerk.example/.well-known/oauth-authorization-server") return Response.json({
        device_authorization_endpoint: "https://clerk.example/oauth/device_authorization",
        token_endpoint: "https://clerk.example/oauth/token",
        grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
      })
      if (url === "https://clerk.example/oauth/device_authorization") {
        assert.equal(new URLSearchParams(String(init?.body)).get("scope"), "openid offline_access")
        return Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://clerk.example/device", expires_in: 60, interval: 0.001 })
      }
      if (url === "https://clerk.example/oauth/token") {
        polls += 1
        if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
        return Response.json({ access_token: "clerk-access-token", refresh_token: "clerk-refresh-token", token_type: "Bearer", expires_in: 3600 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }

    await cmdAuth(["login"], {})
    const stored = JSON.parse(await readFile(keychainPath, "utf8"))
    assert.equal(stored.accessToken, "clerk-access-token")
    assert.equal(stored.refreshToken, "clerk-refresh-token")
    assert.equal(stored.clientId, "oauthapp_public")
    assert.equal(polls, 2)
  })
})

test("expired Clerk access tokens refresh and the rotated token pair is saved", async () => {
  await withKeychain(async keychainPath => {
    await writeFile(keychainPath, JSON.stringify({
      version: 1,
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      accessTokenExpiresAt: Date.now() - 1000,
      tokenEndpoint: "https://clerk.example/oauth/token",
      clientId: "oauthapp_public",
    }))
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://clerk.example/oauth/token")
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get("grant_type"), "refresh_token")
      assert.equal(body.get("refresh_token"), "old-refresh-token")
      return Response.json({ access_token: "new-access-token", refresh_token: "new-refresh-token", token_type: "Bearer", expires_in: 3600 })
    }
    assert.equal(await tokenFromKeychain(), "new-access-token")
    const stored = JSON.parse(await readFile(keychainPath, "utf8"))
    assert.equal(stored.refreshToken, "new-refresh-token")
    assert.ok(stored.accessTokenExpiresAt > Date.now())
  })
})
