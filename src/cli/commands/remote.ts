import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { getConfigDir } from '../../lib/config.js'
import { initStorage, listPlanFiles, resolveByIdOrSlug } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { sourceFormat } from '../../lib/mdx/format.js'
import { EXIT } from '../exit.js'

type Site = { url: string }
type SiteConfig = { version: 1; revisions: Record<string, string> }
type OAuthConfig = { version: 2; clientId: string; issuerUrl: string; audience: string; scope: string; deviceAuthorizationEndpoint: string; tokenEndpoint: string; jwksUrl: string }
type DeviceAuthorizationResponse = { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number }
type OAuthTokenResponse = { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; error?: string; error_description?: string }
type StoredOAuthCredential = { version: 2; provider: 'workos-cli'; siteUrl: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: number; tokenEndpoint: string; clientId: string; issuerUrl: string; audience: string; scope: string }

const DEFAULT_SITE_URL = 'https://planmanager.hacker1db.dev'
const KEYCHAIN_SERVICE = 'plan-manager:site'
type StoredLegacyCredential = { version: 2; provider: 'legacy-token'; siteUrl: string; token: string }
const LEGACY_TOKEN = /^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$/
const UNBOUND_CREDENTIAL = 'Stored credential is not bound to this site. Run "plan auth login" to sign in again.'
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000
const MAX_PROVIDER_RESPONSE_BYTES = 1 << 20


function configPath(): string {
  return join(getConfigDir(), 'site.json')
}

function securityCommand(): string {
  return process.env.PLAN_MANAGER_SECURITY_COMMAND ?? '/usr/bin/security'
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function validSiteUrl(value: string): string {
  const url = new URL(value)
  // Plain http is allowed only for loopback, where traffic never leaves the machine.
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  if (!secure || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PLAN_MANAGER_URL must be a bare https URL, or http://localhost for local testing')
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
  const legacy = await readJson(join(getConfigDir(), 'remotes.json')).catch(() => null) as { remotes?: { name?: unknown; url?: unknown }[]; revisions?: Record<string, unknown> } | null
  const legacyRemote = Array.isArray(legacy?.remotes) ? legacy.remotes.find(remote => remote?.url === site.url && typeof remote.name === 'string') : undefined
  return { version: 1, revisions: legacyRemote ? validRevisions(legacy?.revisions?.[legacyRemote.name as string]) : {} }
}

async function saveConfig(config: SiteConfig): Promise<void> {
  const path = configPath()
  await mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

// Keychain records are namespaced by normalized site origin ("plan-manager:site:<origin>"),
// matching the Go CLI, so a credential issued for one site is never looked up for another.
function siteKeychainService(site: Site): string {
  return `${KEYCHAIN_SERVICE}:${site.url}`
}

function credentialFromKeychain(site: Site): string {
  const result = spawnSync(securityCommand(), ['find-generic-password', '-a', 'plan-manager', '-s', siteKeychainService(site), '-w'], { encoding: 'utf8' })
  if (result.status !== 0) {
    // A record under the old, unnamespaced service is not bound to any site.
    const legacy = spawnSync(securityCommand(), ['find-generic-password', '-a', 'plan-manager', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' })
    if (legacy.status === 0 && legacy.stdout.trim() && !legacy.stdout.includes('"siteUrl"')) throw new Error(UNBOUND_CREDENTIAL)
    throw new Error('Not signed in. Run "plan auth login".')
  }
  return result.stdout.trim()
}

function storeCredential(site: Site, value: string): void {
  const result = spawnSync(securityCommand(), ['add-generic-password', '-U', '-a', 'plan-manager', '-s', siteKeychainService(site), '-w'], { encoding: 'utf8', input: `${value}\n` })
  if (result.status !== 0) throw new Error(`Unable to store credential in macOS Keychain: ${result.stderr.trim()}`)
}

export function storeLegacyToken(site: Site, token: string): void {
  if (!LEGACY_TOKEN.test(token)) throw new Error('Token format is invalid. WorkOS login does not use a pasted token; run "plan auth login" instead.')
  const credential: StoredLegacyCredential = { version: 2, provider: 'legacy-token', siteUrl: site.url, token }
  storeCredential(site, JSON.stringify(credential))
}

function parseStoredOAuthCredential(value: string): StoredOAuthCredential | null {
  try {
    const parsed = JSON.parse(value) as StoredOAuthCredential
    if (parsed.version === 2 && parsed.provider === 'workos-cli' && typeof parsed.siteUrl === 'string' && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string' && typeof parsed.accessTokenExpiresAt === 'number' && typeof parsed.tokenEndpoint === 'string' && typeof parsed.clientId === 'string' && typeof parsed.issuerUrl === 'string' && typeof parsed.audience === 'string' && parsed.scope === 'plans:write') return parsed
  } catch { }
  return null
}

function validateHttpsEndpoint(value: string, label: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${label} must be an HTTPS URL`)
  return url.toString().replace(/\/$/, '')
}

async function boundedResponseJson<T>(response: Response, label: string): Promise<T & OAuthTokenResponse> {
  if (!response.body) return {} as T & OAuthTokenResponse
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`${label} response exceeded 1 MiB`)
    }
    chunks.push(value)
  }
  const data = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(data)
  if (!text) return {} as T & OAuthTokenResponse
  try {
    return JSON.parse(text) as T & OAuthTokenResponse
  } catch {
    if (!response.ok) return {} as T & OAuthTokenResponse
    throw new Error(`${label} returned invalid JSON`)
  }
}

export async function fetchJsonWithDeadline<T>(input: string, init: RequestInit, label: string, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS): Promise<{ response: Response; body: T & OAuthTokenResponse }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    const body = await boundedResponseJson<T>(response, label)
    return { response, body }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function requireOkJson<T>(response: Response, body: T & OAuthTokenResponse, label: string): T {
  if (!response.ok) throw new Error(body.error_description ?? body.error ?? `${label} failed (${response.status})`)
  return body
}

async function getOAuthConfiguration(site: Site): Promise<OAuthConfig> {
  const { response, body } = await fetchJsonWithDeadline<OAuthConfig>(`${site.url}/api/v1`, { headers: { accept: 'application/json' }, redirect: 'error' }, 'Plan Manager auth configuration')
  const value = requireOkJson<OAuthConfig>(response, body, 'Plan Manager auth configuration')
  if (value.version !== 2 || typeof value.clientId !== 'string' || !value.clientId || typeof value.audience !== 'string' || !value.audience || value.scope !== 'plans:write') throw new Error('Plan Manager returned an invalid WorkOS CLI configuration')
  const issuerUrl = validateHttpsEndpoint(value.issuerUrl, 'WorkOS issuer')
  const deviceAuthorizationEndpoint = validateHttpsEndpoint(value.deviceAuthorizationEndpoint, 'Device authorization endpoint')
  const tokenEndpoint = validateHttpsEndpoint(value.tokenEndpoint, 'Token endpoint')
  const jwksUrl = validateHttpsEndpoint(value.jwksUrl, 'JWKS endpoint')
  const issuerOrigin = new URL(issuerUrl).origin
  if (new URL(issuerUrl).pathname !== '/' || new URL(deviceAuthorizationEndpoint).origin !== issuerOrigin || new URL(deviceAuthorizationEndpoint).pathname !== '/oauth2/device_authorization' || new URL(tokenEndpoint).origin !== issuerOrigin || new URL(tokenEndpoint).pathname !== '/oauth2/token' || new URL(jwksUrl).origin !== issuerOrigin || new URL(jwksUrl).pathname !== '/oauth2/jwks') throw new Error('Plan Manager returned cross-origin or nonstandard WorkOS CLI endpoints')
  return { ...value, issuerUrl, deviceAuthorizationEndpoint, tokenEndpoint, jwksUrl }
}

function openVerificationUrl(value: string): void {
  if (!process.stdout.isTTY) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null
  if (!command) return
  const child = spawn(command, [value], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function pollForDeviceToken(config: OAuthConfig, authorization: Required<Pick<DeviceAuthorizationResponse, 'device_code' | 'expires_in'>> & Pick<DeviceAuthorizationResponse, 'interval'>, wait: (ms: number) => Promise<unknown> = sleep): Promise<OAuthTokenResponse> {
  const deadline = Date.now() + authorization.expires_in * 1000
  let intervalSeconds = Math.min(60, Math.max(1, authorization.interval ?? 5))
  while (Date.now() < deadline) {
    const { response, body } = await fetchJsonWithDeadline<OAuthTokenResponse>(config.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: authorization.device_code }),
    }, 'WorkOS device authorization')
    if (response.ok) return body
    if (body.error === 'authorization_pending') {
      await wait(intervalSeconds * 1000)
      continue
    }
    if (body.error === 'slow_down') {
      intervalSeconds = Math.min(60, intervalSeconds + 5)
      await wait(intervalSeconds * 1000)
      continue
    }
    throw new Error(body.error_description ?? body.error ?? `WorkOS device authorization failed (${response.status})`)
  }
  throw new Error('WorkOS device authorization expired. Run plan auth login again.')
}

export async function requestDeviceToken(site: Site, wait: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  const config = await getOAuthConfiguration(site)
  const { response, body } = await fetchJsonWithDeadline<DeviceAuthorizationResponse>(config.deviceAuthorizationEndpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clientId, scope: `openid offline_access ${config.scope}` }),
  }, 'WorkOS device authorization')
  const authorization = requireOkJson<DeviceAuthorizationResponse>(response, body, 'WorkOS device authorization')
  if (!authorization.device_code || !authorization.user_code || !authorization.verification_uri || !Number.isFinite(authorization.expires_in) || authorization.expires_in! <= 0) throw new Error('WorkOS returned an invalid device authorization response')
  const verificationUri = validateHttpsEndpoint(authorization.verification_uri_complete ?? authorization.verification_uri, 'Verification URI')
  if (new URL(verificationUri).origin !== new URL(config.issuerUrl).origin) throw new Error('WorkOS returned a cross-origin verification URI')
  process.stdout.write(`Sign in to Plan Manager\nCode: ${authorization.user_code}\nOpen: ${verificationUri}\nWaiting for approval...\n`)
  openVerificationUrl(verificationUri)
  const token = await pollForDeviceToken(config, { device_code: authorization.device_code, expires_in: authorization.expires_in!, interval: authorization.interval }, wait)
  if (!token.access_token || !token.refresh_token || token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in! <= 0) throw new Error('WorkOS returned an invalid token response')
  const credential: StoredOAuthCredential = { version: 2, provider: 'workos-cli', siteUrl: site.url, accessToken: token.access_token, refreshToken: token.refresh_token, accessTokenExpiresAt: Date.now() + token.expires_in! * 1000, tokenEndpoint: config.tokenEndpoint, clientId: config.clientId, issuerUrl: config.issuerUrl, audience: config.audience, scope: config.scope }
  storeCredential(site, JSON.stringify(credential))
  process.stdout.write(`Signed in to ${site.url} and stored the WorkOS credential in macOS Keychain.\n`)
}

// Returns a bearer token only when the stored credential is bound to exactly this site's origin;
// nothing is refreshed or sent otherwise.
export async function tokenFromKeychain(site: Site = getSite()): Promise<string> {
  const value = credentialFromKeychain(site)
  if (LEGACY_TOKEN.test(value)) throw new Error(UNBOUND_CREDENTIAL)
  let header: { version?: unknown; provider?: unknown; siteUrl?: unknown; token?: unknown } = {}
  try { header = JSON.parse(value) ?? {} } catch { }
  if (header.version === 1) throw new Error('Stored Clerk credential is obsolete. Run "plan auth login" to sign in with WorkOS.')
  if (header.siteUrl !== site.url) throw new Error(UNBOUND_CREDENTIAL)
  if (header.provider === 'legacy-token') {
    if (header.version !== 2 || typeof header.token !== 'string' || !LEGACY_TOKEN.test(header.token)) throw new Error('Stored credential has an invalid format. Run "plan auth login" to sign in again.')
    return header.token
  }
  let credential = parseStoredOAuthCredential(value)
  if (!credential) throw new Error('Stored credential has an invalid format. Run "plan auth login" to sign in again.')
  if (credential.accessTokenExpiresAt <= Date.now() + 30_000) {
    const { response, body } = await fetchJsonWithDeadline<OAuthTokenResponse>(credential.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: credential.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
    }, 'WorkOS token refresh')
    const token = requireOkJson<OAuthTokenResponse>(response, body, 'WorkOS token refresh')
    if (!token.access_token || !token.refresh_token || token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in! <= 0) throw new Error('WorkOS returned an invalid refreshed token pair; sign in again')
    credential = { ...credential, accessToken: token.access_token, refreshToken: token.refresh_token, accessTokenExpiresAt: Date.now() + token.expires_in! * 1000 }
    storeCredential(site, JSON.stringify(credential))
  }
  return credential.accessToken
}

function removeToken(site: Site): void {
  const result = spawnSync(securityCommand(), ['delete-generic-password', '-a', 'plan-manager', '-s', siteKeychainService(site)], { encoding: 'utf8' })
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

export async function cmdAuth(args: string[], opts: { stdin?: boolean; rejectedTokenFlag?: boolean; json?: boolean }): Promise<void> {
  const [sub] = args
  try {
    const site = getSite()
    if (sub === 'login') {
      if (opts.rejectedTokenFlag) throw new Error('The --token option is not accepted because it exposes the credential in process arguments. Pipe a legacy pm_ token to "plan auth login --stdin" instead.')
      if (opts.stdin) {
        const token = await readStdin()
        storeLegacyToken(site, token)
        process.stdout.write(opts.json ? JSON.stringify({ site: site.url, credential: 'configured', type: 'legacy' }) + '\n' : `Stored Plan Manager token for ${site.url} in macOS Keychain.\n`)
      } else {
        await requestDeviceToken(site)
        if (opts.json) process.stdout.write(JSON.stringify({ site: site.url, credential: 'configured', type: 'workos-cli' }) + '\n')
      }
      return
    }
    if (sub === 'logout') {
      removeToken(site)
      process.stdout.write(opts.json ? JSON.stringify({ site: site.url, credential: 'removed' }) + '\n' : `Removed credential for ${site.url}.\n`)
      return
    }
    if (sub === 'status') {
      let configured = false
      try { await tokenFromKeychain(site); configured = true } catch { }
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
    redirect: 'error',
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
    const token = await tokenFromKeychain(site)
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
