import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { initStorage, listPlanFiles, resolveByIdOrSlug } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { sourceFormat } from '../../lib/mdx/format.js'
import { EXIT } from '../exit.js'

type Site = { url: string }
type SiteConfig = { version: 1; revisions: Record<string, string> }
type OAuthConfig = { clientId: string; issuerUrl: string }
type OAuthMetadata = { authorization_endpoint?: string; token_endpoint?: string }
type OAuthTokenResponse = { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; error?: string; error_description?: string }
type StoredOAuthCredential = { version: 1; accessToken: string; refreshToken: string; accessTokenExpiresAt: number; tokenEndpoint: string; clientId: string }

const DEFAULT_SITE_URL = 'https://planmanager.hacker1db.dev'
const KEYCHAIN_SERVICE = 'plan-manager:site'

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plan-manager')
}

function configPath(): string {
  return join(configDir(), 'site.json')
}

function securityCommand(): string {
  return process.env.PLAN_MANAGER_SECURITY_COMMAND ?? '/usr/bin/security'
}

function validSiteUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PLAN_MANAGER_URL must be a bare https URL')
  return url.toString().replace(/\/$/, '')
}

export function getSite(): Site {
  return { url: validSiteUrl(process.env.PLAN_MANAGER_URL?.trim() || DEFAULT_SITE_URL) }
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Unable to read ${path}: ${(error as Error).message}`)
  }
}

function validRevisions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function loadConfig(site: Site): Promise<SiteConfig> {
  const parsed = await readJson(configPath()) as Partial<SiteConfig> | null
  if (parsed) {
    if (parsed.version !== 1) throw new Error(`Unable to read ${configPath()}: unsupported version`)
    return { version: 1, revisions: validRevisions(parsed.revisions) }
  }
  // Carry push revisions over from the multi-remote config so conflict detection keeps working.
  const legacy = await readJson(join(configDir(), 'remotes.json')).catch(() => null) as { remotes?: { name?: unknown; url?: unknown }[]; revisions?: Record<string, unknown> } | null
  const legacyRemote = Array.isArray(legacy?.remotes) ? legacy.remotes.find(remote => remote?.url === site.url && typeof remote.name === 'string') : undefined
  return { version: 1, revisions: legacyRemote ? validRevisions(legacy?.revisions?.[legacyRemote.name as string]) : {} }
}

async function saveConfig(config: SiteConfig): Promise<void> {
  const path = configPath()
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

function credentialFromKeychain(): string {
  const result = spawnSync(securityCommand(), ['find-generic-password', '-a', 'plan-manager', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Not signed in. Run "plan auth login".')
  return result.stdout.trim()
}

function storeCredential(value: string): void {
  const result = spawnSync(securityCommand(), ['add-generic-password', '-U', '-a', 'plan-manager', '-s', KEYCHAIN_SERVICE, '-w', value], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to store credential in macOS Keychain: ${result.stderr.trim()}`)
}

function storeLegacyToken(token: string): void {
  if (!/^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Token format is invalid. Clerk login no longer needs a pasted token; run "plan auth login" instead.')
  storeCredential(token)
}

function parseStoredOAuthCredential(value: string): StoredOAuthCredential | null {
  try {
    const parsed = JSON.parse(value) as StoredOAuthCredential
    if (parsed.version === 1 && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string' && typeof parsed.accessTokenExpiresAt === 'number' && typeof parsed.tokenEndpoint === 'string' && typeof parsed.clientId === 'string') return parsed
  } catch { }
  return null
}

function validateHttpsEndpoint(value: string, label: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} must be an HTTPS URL`)
  return url.toString()
}

async function responseJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & OAuthTokenResponse
  if (!response.ok) throw new Error(body.error_description ?? body.error ?? `${label} failed (${response.status})`)
  return body
}

async function getOAuthConfiguration(site: Site): Promise<OAuthConfig> {
  const response = await fetch(`${site.url}/api/v1`, { headers: { accept: 'application/json' } })
  const value = await responseJson<OAuthConfig>(response, 'Plan Manager auth configuration')
  if (typeof value.clientId !== 'string' || !value.clientId || typeof value.issuerUrl !== 'string') throw new Error('Plan Manager returned an invalid OAuth configuration')
  return { clientId: value.clientId, issuerUrl: validateHttpsEndpoint(value.issuerUrl, 'Clerk issuer') }
}

async function getOAuthMetadata(issuerUrl: string): Promise<OAuthMetadata> {
  const metadataUrl = new URL('/.well-known/oauth-authorization-server', issuerUrl)
  const response = await fetch(metadataUrl, { headers: { accept: 'application/json' } })
  const metadata = await responseJson<OAuthMetadata>(response, 'Clerk OAuth metadata')
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('This Clerk instance does not advertise Authorization Code with PKCE. Enable it for the Plan Manager CLI application in Clerk.')
  }
  return {
    authorization_endpoint: validateHttpsEndpoint(metadata.authorization_endpoint, 'Authorization endpoint'),
    token_endpoint: validateHttpsEndpoint(metadata.token_endpoint, 'Token endpoint'),
  }
}

function openVerificationUrl(value: string): void {
  if (!process.stdout.isTTY) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null
  if (!command) return
  const child = spawn(command, [value], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function sameState(expected: string, received: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

type AuthorizationCallback = { code: string }

async function startAuthorizationCallback(state: string): Promise<{ redirectUri: string; result: Promise<AuthorizationCallback> }> {
  let resolveResult!: (value: AuthorizationCallback) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<AuthorizationCallback>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end('Not found')
      return
    }
    const receivedState = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (!receivedState || !sameState(state, receivedState)) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Plan Manager sign-in could not be verified. Return to the sign-in page and try again.</p>')
    } else if (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Plan Manager sign-in was cancelled. You may close this window.</p>')
      rejectResult(new Error(`Clerk authorization failed: ${error}`))
      server.close()
    } else if (!code) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Plan Manager sign-in failed. Return to the sign-in page and try again.</p>')
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Plan Manager sign-in complete. You may close this window.</p>')
      resolveResult({ code })
      server.close()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to start the local OAuth callback server')
  }
  const timeout = setTimeout(() => {
    server.close()
    rejectResult(new Error('Sign-in timed out. Run plan auth login again to start a new sign-in.'))
  }, 5 * 60_000)
  result.finally(() => clearTimeout(timeout)).catch(() => undefined)
  return { redirectUri: `http://127.0.0.1:${address.port}/callback`, result }
}

export async function requestAuthorizationCodeToken(site: Site): Promise<void> {
  const config = await getOAuthConfiguration(site)
  const metadata = await getOAuthMetadata(config.issuerUrl)
  const state = base64Url(randomBytes(32))
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const callback = await startAuthorizationCallback(state)
  const authorizationUrl = new URL(metadata.authorization_endpoint!)
  authorizationUrl.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: callback.redirectUri, scope: 'openid offline_access', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
  process.stdout.write(`Sign in to Plan Manager\nOpen: ${authorizationUrl.toString()}\nWaiting for approval...\n`)
  openVerificationUrl(authorizationUrl.toString())
  const { code } = await callback.result
  const tokenResponse = await fetch(metadata.token_endpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clientId, grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, code_verifier: verifier }),
  })
  const token = await responseJson<OAuthTokenResponse>(tokenResponse, 'Clerk authorization code exchange')
  if (!token.access_token || !token.refresh_token || token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in)) throw new Error('Clerk returned an invalid token response')
  const credential: StoredOAuthCredential = { version: 1, accessToken: token.access_token, refreshToken: token.refresh_token, accessTokenExpiresAt: Date.now() + token.expires_in! * 1000, tokenEndpoint: metadata.token_endpoint!, clientId: config.clientId }
  storeCredential(JSON.stringify(credential))
  process.stdout.write(`Signed in to ${site.url} and stored the Clerk credential in macOS Keychain.\n`)
}

export async function tokenFromKeychain(): Promise<string> {
  const value = credentialFromKeychain()
  if (/^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$/.test(value)) return value
  let credential = parseStoredOAuthCredential(value)
  if (!credential) throw new Error('Stored credential has an invalid format. Run "plan auth login" to sign in again.')
  if (credential.accessTokenExpiresAt <= Date.now() + 30_000) {
    const response = await fetch(credential.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: credential.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
    })
    const token = await responseJson<OAuthTokenResponse>(response, 'Clerk token refresh')
    if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('Clerk returned an invalid refreshed token')
    credential = { ...credential, accessToken: token.access_token, refreshToken: token.refresh_token ?? credential.refreshToken, accessTokenExpiresAt: Date.now() + token.expires_in! * 1000 }
    storeCredential(JSON.stringify(credential))
  }
  return credential.accessToken
}

function removeToken(): void {
  const result = spawnSync(securityCommand(), ['delete-generic-password', '-a', 'plan-manager', '-s', KEYCHAIN_SERVICE], { encoding: 'utf8' })
  if (result.status !== 0 && !/could not be found/i.test(result.stderr)) throw new Error(`Unable to remove Keychain credential: ${result.stderr.trim()}`)
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', reject)
  })
}

function fail(message: string, code = EXIT.INVALID_INPUT): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(code)
}

export async function cmdAuth(args: string[], opts: { stdin?: boolean; token?: string; json?: boolean }): Promise<void> {
  const [sub] = args
  try {
    const site = getSite()
    if (sub === 'login') {
      if (opts.stdin || opts.token) {
        const token = opts.stdin ? await readStdin() : opts.token!
        storeLegacyToken(token)
        process.stdout.write(opts.json ? JSON.stringify({ site: site.url, credential: 'configured', type: 'legacy' }) + '\n' : `Stored Plan Manager token for ${site.url} in macOS Keychain.\n`)
      } else {
        await requestAuthorizationCodeToken(site)
        if (opts.json) process.stdout.write(JSON.stringify({ site: site.url, credential: 'configured', type: 'clerk-oauth' }) + '\n')
      }
      return
    }
    if (sub === 'logout') {
      removeToken()
      process.stdout.write(opts.json ? JSON.stringify({ site: site.url, credential: 'removed' }) + '\n' : `Removed credential for ${site.url}.\n`)
      return
    }
    if (sub === 'status') {
      let configured = false
      try { await tokenFromKeychain(); configured = true } catch { }
      const result = { version: 1, site: site.url, credential: configured ? 'configured' : 'missing' }
      process.stdout.write(opts.json ? JSON.stringify(result) + '\n' : `${site.url}: ${configured ? 'signed in' : 'not signed in'}\n`)
      return
    }
  } catch (error) { fail((error as Error).message) }
  fail(`Unknown auth subcommand: ${sub ?? '(none)'}\nUsage: plan auth <login|logout|status>`)
}

async function pushOne(site: Site, token: string, identifier: string, expectedRevision: string | null): Promise<{ id: string; url: string; revision: string }> {
  const resolved = await resolveByIdOrSlug(identifier)
  const parsed = await readPlan(resolved.filePath)
  if (parsed.meta.format === 'mdx' && sourceFormat(parsed.raw) !== 'mdx') {
    throw new Error(`MDX plan ${parsed.meta.id} needs "format: mdx" in its frontmatter so the hosted site renders it; add it or run plan update`)
  }
  const envelope = await buildEnvelope(parsed)
  const response = await fetch(`${site.url}/api/v1/plans/${encodeURIComponent(envelope.id)}/versions`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id: envelope.id, title: envelope.title, status: envelope.status, tags: envelope.tags, created: envelope.created, updated: envelope.updated, markdown: parsed.raw, revision: envelope.revision, expectedRevision }),
  })
  const body = await response.json().catch(() => ({})) as { error?: string; currentRevision?: string; url?: string; plan?: { revision?: string } }
  if (response.status === 409) throw new Error(`Revision conflict for ${envelope.id}; site is at ${body.currentRevision ?? 'an unknown revision'}`)
  if (!response.ok) throw new Error(`Push failed (${response.status}): ${body.error ?? 'unexpected response'}`)
  return { id: envelope.id, url: new URL(body.url ?? `/plans/${envelope.id}`, site.url).toString(), revision: body.plan?.revision ?? envelope.revision }
}

export async function cmdPush(args: string[], opts: { json?: boolean }): Promise<void> {
  const identifier = args[0]
  if (!identifier) fail('Usage: plan push <id-or-slug|--all>')
  try {
    await initStorage()
    const site = getSite()
    const config = await loadConfig(site)
    const token = await tokenFromKeychain()
    const identifiers = identifier === '--all' ? await Promise.all((await listPlanFiles()).map(async path => (await readPlan(path)).meta.id)) : [identifier]
    const results = []
    for (const item of identifiers) {
      const result = await pushOne(site, token, item, config.revisions[item] ?? null)
      config.revisions[result.id] = result.revision
      results.push(result)
    }
    await saveConfig(config)
    process.stdout.write(opts.json ? JSON.stringify({ version: 1, site: site.url, plans: results }) + '\n' : results.map(result => `Pushed ${result.id}: ${result.url}`).join('\n') + '\n')
  } catch (error) { fail((error as Error).message, (error as Error).message.includes('Revision conflict') ? EXIT.CONFLICT : EXIT.DEPENDENCY_UNAVAILABLE) }
}
