import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { getCliOAuthConfiguration, workosCliClaimsCanAccess } from "./env"

const remoteJwks = new Map<string, JWTVerifyGetKey>()

function jwksFor(url: string): JWTVerifyGetKey {
  let key = remoteJwks.get(url)
  if (!key) {
    key = createRemoteJWKSet(new URL(url))
    remoteJwks.set(url, key)
  }
  return key
}

export async function verifyWorkosCliToken(
  token: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
  getKey?: JWTVerifyGetKey,
): Promise<boolean> {
  const config = getCliOAuthConfiguration(source)
  const { payload } = await jwtVerify(token, getKey ?? jwksFor(config.jwksUrl), {
    algorithms: ["RS256"],
    issuer: config.issuerUrl,
    audience: config.audience,
    requiredClaims: ["exp", "sub"],
  })
  return workosCliClaimsCanAccess(payload.sub, payload.client_id, payload.scope, source)
}
