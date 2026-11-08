export const WORKOS_CLI_SCOPE = "plans:write"

type HostedEnvironment = {
  workosClientId: string
  workosApiKey: string
  workosCookiePassword: string
  workosRedirectUri: string
  ownerWorkosUserIds: string[]
  databaseUrl: string
  blobReadWriteToken: string
  tokenPepper: string
}

export type WorkOSCliConfiguration = {
  version: 2
  clientId: string
  issuerUrl: string
  audience: string
  scope: typeof WORKOS_CLI_SCOPE
  deviceAuthorizationEndpoint: string
  tokenEndpoint: string
  jwksUrl: string
}

export class HostedConfigurationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Hosted Plan Manager is not configured: missing or invalid ${missing.join(", ")}`)
    this.name = "HostedConfigurationError"
  }
}

const REQUIRED_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_REDIRECT_URI",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "PLAN_MANAGER_TOKEN_PEPPER",
] as const

function uniqueList(value: string): string[] {
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))]
}

function httpsUrl(value: string | undefined, key: string, originOnly = false): string {
  try {
    const url = new URL(value ?? "")
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== "/")) throw new Error()
    return originOnly ? url.origin : url.toString().replace(/\/$/, "")
  } catch {
    throw new HostedConfigurationError([key])
  }
}

function redirectUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "")
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/callback") throw new Error()
    return url.toString()
  } catch {
    throw new HostedConfigurationError(["WORKOS_REDIRECT_URI"])
  }
}

export function getOwnerWorkosUserIds(source: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return uniqueList(source.PLAN_MANAGER_OWNER_WORKOS_USER_IDS?.trim() ?? "")
}

export function isAllowedOwner(userId: string | null | undefined, source: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return typeof userId === "string" && getOwnerWorkosUserIds(source).includes(userId)
}

export function getHostedEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): HostedEnvironment {
  const ownerWorkosUserIds = getOwnerWorkosUserIds(source)
  const missing = [
    ...REQUIRED_KEYS.filter(key => !source[key]?.trim()),
    ...(ownerWorkosUserIds.length === 0 ? ["PLAN_MANAGER_OWNER_WORKOS_USER_IDS"] : []),
    ...((source.WORKOS_COOKIE_PASSWORD?.length ?? 0) < 32 ? ["WORKOS_COOKIE_PASSWORD"] : []),
  ]
  if (missing.length > 0) throw new HostedConfigurationError([...new Set(missing)])
  return {
    workosClientId: source.WORKOS_CLIENT_ID!,
    workosApiKey: source.WORKOS_API_KEY!,
    workosCookiePassword: source.WORKOS_COOKIE_PASSWORD!,
    workosRedirectUri: redirectUrl(source.WORKOS_REDIRECT_URI),
    ownerWorkosUserIds,
    databaseUrl: source.DATABASE_URL!,
    blobReadWriteToken: source.BLOB_READ_WRITE_TOKEN!,
    tokenPepper: source.PLAN_MANAGER_TOKEN_PEPPER!,
  }
}

export function ownerConfigured(source: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    getHostedEnvironment(source)
    return true
  } catch {
    return false
  }
}

export function getCliOAuthConfiguration(source: Readonly<Record<string, string | undefined>> = process.env): WorkOSCliConfiguration {
  const clientId = source.PLAN_MANAGER_WORKOS_CLI_CLIENT_ID?.trim()
  const audience = source.PLAN_MANAGER_WORKOS_CLI_AUDIENCE?.trim()
  if (!clientId || !audience) {
    throw new HostedConfigurationError([
      ...(!clientId ? ["PLAN_MANAGER_WORKOS_CLI_CLIENT_ID"] : []),
      ...(!audience ? ["PLAN_MANAGER_WORKOS_CLI_AUDIENCE"] : []),
    ])
  }
  const issuerUrl = httpsUrl(source.PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN, "PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN", true)
  return {
    version: 2,
    clientId,
    issuerUrl,
    audience,
    scope: WORKOS_CLI_SCOPE,
    deviceAuthorizationEndpoint: `${issuerUrl}/oauth2/device_authorization`,
    tokenEndpoint: `${issuerUrl}/oauth2/token`,
    jwksUrl: `${issuerUrl}/oauth2/jwks`,
  }
}

export function workosCliClaimsCanAccess(
  userId: unknown,
  clientId: unknown,
  scope: unknown,
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const config = getCliOAuthConfiguration(source)
  const scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : []
  return typeof userId === "string" && isAllowedOwner(userId, source) && clientId === config.clientId && scopes.includes(config.scope)
}
