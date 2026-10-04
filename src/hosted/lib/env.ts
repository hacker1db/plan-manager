type HostedEnvironment = {
  clerkPublishableKey: string
  clerkSecretKey: string
  ownerClerkUserId: string
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
  "PLAN_MANAGER_OWNER_CLERK_USER_ID",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "PLAN_MANAGER_TOKEN_PEPPER",
] as const

export function getHostedEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): HostedEnvironment {
  const missing = REQUIRED_KEYS.filter(key => !source[key]?.trim())
  if (missing.length > 0) throw new HostedConfigurationError([...missing])
  return {
    clerkPublishableKey: source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
    clerkSecretKey: source.CLERK_SECRET_KEY!,
    ownerClerkUserId: source.PLAN_MANAGER_OWNER_CLERK_USER_ID!,
    databaseUrl: source.DATABASE_URL!,
    blobReadWriteToken: source.BLOB_READ_WRITE_TOKEN!,
    tokenPepper: source.PLAN_MANAGER_TOKEN_PEPPER!,
  }
}

export function ownerConfigured(source: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(source.CLERK_SECRET_KEY && source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && source.PLAN_MANAGER_OWNER_CLERK_USER_ID)
}
