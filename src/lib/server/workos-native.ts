import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { environmentSource, HostedConfigurationError, isAllowedOwner } from "./env"

// Native (iOS) clients sign in through the WorkOS public-client PKCE flow and send the
// resulting User Management access token as a bearer. These tokens are a different class
// from CLI Connect tokens: they are issued by `user_management/<clientId>` rather than the
// AuthKit domain, so the exact issuer check keeps the two from being interchangeable.

export type WorkOSNativeConfiguration = {
  clientId: string
  issuer: string
  jwksUrl: string
}

const WORKOS_API_ORIGIN = "https://api.workos.com"

function httpsIssuer(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error()
    return value.replace(/\/$/, "")
  } catch {
    throw new HostedConfigurationError(["PLAN_MANAGER_WORKOS_NATIVE_ISSUER"])
  }
}

export function getNativeOAuthConfiguration(source: Readonly<Record<string, string | undefined>> = environmentSource()): WorkOSNativeConfiguration {
  // Opt-in: native bearer access stays disabled until the owner names the approved client.
  const clientId = source.PLAN_MANAGER_WORKOS_NATIVE_CLIENT_ID?.trim()
  if (!clientId || !/^client_[A-Za-z0-9]+$/.test(clientId)) throw new HostedConfigurationError(["PLAN_MANAGER_WORKOS_NATIVE_CLIENT_ID"])
  const override = source.PLAN_MANAGER_WORKOS_NATIVE_ISSUER?.trim()
  return {
    clientId,
    issuer: override ? httpsIssuer(override) : `${WORKOS_API_ORIGIN}/user_management/${clientId}`,
    jwksUrl: `${WORKOS_API_ORIGIN}/sso/jwks/${clientId}`,
  }
}

const remoteJwks = new Map<string, JWTVerifyGetKey>()

function jwksFor(url: string): JWTVerifyGetKey {
  let key = remoteJwks.get(url)
  if (!key) {
    key = createRemoteJWKSet(new URL(url))
    remoteJwks.set(url, key)
  }
  return key
}

/**
 * Verifies a native WorkOS access token and returns the owner's user ID, or null when the
 * token is valid but does not belong to an allowed owner. Throws on any signature, issuer,
 * algorithm, or expiry failure, and HostedConfigurationError when native access is not configured.
 */
export async function verifyWorkosNativeToken(
  token: string,
  source: Readonly<Record<string, string | undefined>> = environmentSource(),
  getKey?: JWTVerifyGetKey,
): Promise<string | null> {
  const config = getNativeOAuthConfiguration(source)
  const { payload } = await jwtVerify(token, getKey ?? jwksFor(config.jwksUrl), {
    algorithms: ["RS256"],
    issuer: config.issuer,
    requiredClaims: ["exp", "sub"],
  })
  return isAllowedOwner(payload.sub, source) ? payload.sub! : null
}
