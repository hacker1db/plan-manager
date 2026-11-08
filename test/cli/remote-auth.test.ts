import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { get } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { cmdAuth, requestAuthorizationCodeToken, tokenFromKeychain } from "../../src/cli/commands/remote"

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
if (action === 'add-generic-password') {
  // Like the real tool with a trailing -w: the password arrives on stdin
  // (entered twice), never in argv. Record argv so tests can prove the
  // secret is not exposed on the process argument list.
  fs.writeFileSync(file + '.argv', JSON.stringify(args))
  if (args[args.length - 1] !== '-w') process.exit(2)
  const [first, second] = fs.readFileSync(0, 'utf8').split('\\n')
  if (first !== second) process.exit(1)
  fs.writeFileSync(file, first)
}
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

function visit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, response => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)) }).once("error", reject)
  })
}

test("stored credentials never appear in the security(1) argument list", async () => {
  await withKeychain(async keychainPath => {
    const token = `pm_${"a".repeat(18)}_${"b".repeat(43)}`
    await cmdAuth(["login"], { token, json: true })
    assert.equal(await readFile(keychainPath, "utf8"), token)
    const argv: string[] = JSON.parse(await readFile(`${keychainPath}.argv`, "utf8"))
    assert.ok(!argv.includes(token), "secret must not be passed as an argv value")
    assert.ok(!argv.some(arg => arg.includes(token)), "secret must not be embedded in any argument")
    assert.equal(argv[argv.length - 1], "-w", "security must read the secret from stdin via a trailing -w")
  })
})

test("Clerk PKCE login receives a loopback code and stores the OAuth pair in Keychain", async () => {
  await withKeychain(async keychainPath => {
    let authorizationUrl = ""
    const previousWrite = process.stdout.write
    process.stdout.write = ((value: string | Uint8Array) => {
      const text = String(value)
      const match = text.match(/Open: (https:\/\/[^\n]+)/)
      if (match) authorizationUrl = match[1]
      return true
    }) as typeof process.stdout.write
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === "https://plans.example/api/v1") return Response.json({ clientId: "oauthapp_public", issuerUrl: "https://clerk.example" })
      if (url === "https://clerk.example/.well-known/oauth-authorization-server") return Response.json({
        authorization_endpoint: "https://clerk.example/oauth/authorize",
        token_endpoint: "https://clerk.example/oauth/token",
        grant_types_supported: ["authorization_code"],
        response_types_supported: ["code"],
      })
      if (url === "https://clerk.example/oauth/token") {
        const body = new URLSearchParams(String(init?.body))
        assert.equal(body.get("grant_type"), "authorization_code")
        assert.equal(body.get("code"), "authorization-code")
        assert.equal(body.get("redirect_uri"), new URL(authorizationUrl).searchParams.get("redirect_uri"))
        const verifier = body.get("code_verifier")!
        assert.equal(new URL(authorizationUrl).searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"))
        assert.equal(new URL(authorizationUrl).searchParams.get("code_challenge_method"), "S256")
        return Response.json({ access_token: "clerk-access-token", refresh_token: "clerk-refresh-token", token_type: "Bearer", expires_in: 3600 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }
    try {
      const login = cmdAuth(["login"], {})
      while (!authorizationUrl) await new Promise(resolve => setTimeout(resolve, 1))
      const authorize = new URL(authorizationUrl)
      assert.equal(authorize.searchParams.get("response_type"), "code")
      assert.equal(authorize.searchParams.get("scope"), "openid offline_access")
      const callback = new URL(authorize.searchParams.get("redirect_uri")!)
      assert.equal(callback.protocol, "http:")
      assert.equal(callback.hostname, "127.0.0.1")
      assert.equal(await visit(`${callback}?code=wrong-code&state=wrong-state`), 400)
      assert.equal(await visit(`${callback}?error=access_denied&error_description=untrusted&state=wrong-state`), 400)
      assert.equal(await visit(`${callback}?state=${encodeURIComponent(authorize.searchParams.get("state")!)}`), 400)
      assert.equal(await visit(`${callback}?code=authorization-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`), 200)
      await login
      const stored = JSON.parse(await readFile(keychainPath, "utf8"))
      assert.equal(stored.accessToken, "clerk-access-token")
      assert.equal(stored.refreshToken, "clerk-refresh-token")
      assert.equal(stored.clientId, "oauthapp_public")
    } finally {
      process.stdout.write = previousWrite
    }
  })
})

test("Clerk PKCE login rejects a provider error and closes the loopback callback", async () => {
  await withKeychain(async () => {
    let authorizationUrl = ""
    const previousWrite = process.stdout.write
    process.stdout.write = ((value: string | Uint8Array) => {
      const match = String(value).match(/Open: (https:\/\/[^\n]+)/)
      if (match) authorizationUrl = match[1]
      return true
    }) as typeof process.stdout.write
    globalThis.fetch = async input => {
      const url = String(input)
      if (url === "https://plans.example/api/v1") return Response.json({ clientId: "oauthapp_public", issuerUrl: "https://clerk.example" })
      if (url === "https://clerk.example/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://clerk.example/oauth/authorize", token_endpoint: "https://clerk.example/oauth/token" })
      throw new Error(`Unexpected request: ${url}`)
    }
    try {
      const login = requestAuthorizationCodeToken({ url: "https://plans.example" })
      while (!authorizationUrl) await new Promise(resolve => setTimeout(resolve, 1))
      const authorize = new URL(authorizationUrl)
      const callback = new URL(authorize.searchParams.get("redirect_uri")!)
      const rejected = assert.rejects(login, /Clerk authorization failed: access_denied/)
      assert.equal(await visit(`${callback}?error=access_denied&error_description=Nope&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`), 400)
      await rejected
    } finally {
      process.stdout.write = previousWrite
    }
  })
})

test("failed PKCE token exchange does not store a credential", async () => {
  await withKeychain(async keychainPath => {
    let authorizationUrl = ""
    const previousWrite = process.stdout.write
    process.stdout.write = ((value: string | Uint8Array) => {
      const match = String(value).match(/Open: (https:\/\/[^\n]+)/)
      if (match) authorizationUrl = match[1]
      return true
    }) as typeof process.stdout.write
    globalThis.fetch = async input => {
      const url = String(input)
      if (url === "https://plans.example/api/v1") return Response.json({ clientId: "oauthapp_public", issuerUrl: "https://clerk.example" })
      if (url === "https://clerk.example/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://clerk.example/oauth/authorize", token_endpoint: "https://clerk.example/oauth/token" })
      if (url === "https://clerk.example/oauth/token") return Response.json({ error: "invalid_grant" }, { status: 400 })
      throw new Error(`Unexpected request: ${url}`)
    }
    try {
      const login = requestAuthorizationCodeToken({ url: "https://plans.example" })
      while (!authorizationUrl) await new Promise(resolve => setTimeout(resolve, 1))
      const authorize = new URL(authorizationUrl)
      const callback = new URL(authorize.searchParams.get("redirect_uri")!)
      const rejected = assert.rejects(login, /invalid_grant/)
      assert.equal(await visit(`${callback}?code=authorization-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`), 200)
      await rejected
      await assert.rejects(readFile(keychainPath, "utf8"), { code: "ENOENT" })
    } finally {
      process.stdout.write = previousWrite
    }
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
