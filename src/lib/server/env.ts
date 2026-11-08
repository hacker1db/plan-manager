type EnvironmentSource = Readonly<Record<string, string | undefined>>

// Server-only: SvelteKit's hook installs $env/dynamic/private here so .env files work in
// `vite dev`; on Vercel this is process.env. Variable names are unchanged from the Next.js app.
let activeSource: EnvironmentSource = process.env

export function setEnvironmentSource(next: EnvironmentSource): void {
  activeSource = next
}

export function environmentSource(): EnvironmentSource {
  return activeSource
}

type HostedEnvironment = {
  clerkPublishableKey: string
  clerkSecretKey: string
  ownerClerkUserIds: string[]
  databaseUrl: string
  blobReadWriteToken: string
  tokenPepper: string
}

export class HostedConfigurationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Hosted Plan Manager is not configured: missing ${missing.join(", ")}`)
    this.name = "HostedConfigurationError"
  }
}

const REQUIRED_KEYS = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "PLAN_MANAGER_TOKEN_PEPPER",
] as const

export function getOwnerClerkUserIds(source: Readonly<Record<string, string | undefined>> = environmentSource()): string[] {
  const value = source.PLAN_MANAGER_OWNER_CLERK_USER_IDS?.trim() || source.PLAN_MANAGER_OWNER_CLERK_USER_ID?.trim() || ""
  return [...new Set(value.split(",").map(userId => userId.trim()).filter(Boolean))]
}

export function isAllowedOwner(userId: string | null | undefined, source: Readonly<Record<string, string | undefined>> = environmentSource()): boolean {
  return typeof userId === "string" && getOwnerClerkUserIds(source).includes(userId)
}

// Clerk custom scopes can only be created in the dashboard, so CLI access is bound to the
// Plan Manager CLI OAuth application instead: tokens minted for any other client are rejected.
export function oauthTokenCanAccess(userId: string | null, clientId: string | null, scopes: readonly string[], source: Readonly<Record<string, string | undefined>> = environmentSource()): boolean {
  const cliClientId = source.PLAN_MANAGER_OAUTH_CLIENT_ID?.trim()
  return isAllowedOwner(userId, source) && Boolean(cliClientId) && clientId === cliClientId && scopes.includes("openid")
}

export function getHostedEnvironment(source: Readonly<Record<string, string | undefined>> = environmentSource()): HostedEnvironment {
  const ownerClerkUserIds = getOwnerClerkUserIds(source)
  const missing = [
    ...REQUIRED_KEYS.filter(key => !source[key]?.trim()),
    ...(ownerClerkUserIds.length === 0 ? ["PLAN_MANAGER_OWNER_CLERK_USER_IDS"] : []),
  ]
  if (missing.length > 0) throw new HostedConfigurationError([...missing])
  return {
    clerkPublishableKey: source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
    clerkSecretKey: source.CLERK_SECRET_KEY!,
    ownerClerkUserIds,
    databaseUrl: source.DATABASE_URL!,
    blobReadWriteToken: source.BLOB_READ_WRITE_TOKEN!,
    tokenPepper: source.PLAN_MANAGER_TOKEN_PEPPER!,
  }
}

export function ownerConfigured(source: Readonly<Record<string, string | undefined>> = environmentSource()): boolean {
  return Boolean(source.CLERK_SECRET_KEY && source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && getOwnerClerkUserIds(source).length > 0)
}

export function getClerkIssuerUrl(source: Readonly<Record<string, string | undefined>> = environmentSource()): string {
  const key = source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? ""
  const encodedDomain = key.split("_").slice(2).join("_")
  if (!/^pk_(test|live)_[A-Za-z0-9_-]+$/.test(key) || !encodedDomain) throw new HostedConfigurationError(["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"])
  let domain: string
  try {
    const base64 = encodedDomain.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encodedDomain.length / 4) * 4, "=")
    domain = atob(base64).replace(/\$$/, "")
  } catch {
    throw new HostedConfigurationError(["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"])
  }
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) throw new HostedConfigurationError(["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"])
  return `https://${domain}`
}

export function getCliOAuthConfiguration(source: Readonly<Record<string, string | undefined>> = environmentSource()): { clientId: string; issuerUrl: string } {
  const clientId = source.PLAN_MANAGER_OAUTH_CLIENT_ID?.trim()
  if (!clientId) throw new HostedConfigurationError(["PLAN_MANAGER_OAUTH_CLIENT_ID"])
  return { clientId, issuerUrl: getClerkIssuerUrl(source) }
}

// Same variable the Next.js Clerk SDK read. When unset, signed-out visitors go to the
// Clerk Account Portal sign-in page, exactly as `redirectToSignIn()` did before.
export function getClerkSignInUrl(source: Readonly<Record<string, string | undefined>> = environmentSource()): string | undefined {
  return source.NEXT_PUBLIC_CLERK_SIGN_IN_URL?.trim() || undefined
}
