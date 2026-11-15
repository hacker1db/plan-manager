import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { PLAN_SCOPES, type CliToken, type PlanScope, type TokenRecord, type TokenSummary } from "../hosted/types.ts"
import { requireJsonObject, ValidationError } from "./sanitize.ts"

const scrypt = promisify(rawScrypt)

// pm_ tokens are bearer credentials with no WorkOS session or MFA binding, so cap their lifetime.
export const MAX_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

export function isPlanScope(value: string): value is PlanScope {
  return (PLAN_SCOPES as readonly string[]).includes(value)
}

export function generateToken(id = randomBytes(9).toString("hex")): { id: string; secret: string; bearer: string } {
  const secret = randomBytes(32).toString("base64url")
  return { id, secret, bearer: `pm_${id}_${secret}` }
}

export function parseBearer(value: string | null): { id: string; secret: string } | null {
  if (!value?.startsWith("Bearer pm_")) return null
  const token = value.slice("Bearer pm_".length)
  const separator = token.indexOf("_")
  if (separator < 1) return null
  const id = token.slice(0, separator)
  const secret = token.slice(separator + 1)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null
  return { id, secret }
}

export async function hashSecret(secret: string, pepper: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(`${pepper}:${secret}`, salt, 64) as Buffer
  return `${salt.toString("base64url")}.${derived.toString("base64url")}`
}

export async function verifySecret(secret: string, pepper: string, encoded: string): Promise<boolean> {
  const [saltValue, hashValue] = encoded.split(".")
  if (!saltValue || !hashValue) return false
  const salt = Buffer.from(saltValue, "base64url")
  const expected = Buffer.from(hashValue, "base64url")
  const actual = await scrypt(`${pepper}:${secret}`, salt, expected.length) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function tokenCanAccess(token: CliToken, scope: PlanScope, now = new Date()): boolean {
  return token.revokedAt === null && token.expiresAt > now && token.scopes.includes(scope)
}

export async function tokenAuthorizes(record: TokenRecord | null, secret: string, pepper: string, scope: PlanScope, now = new Date()): Promise<boolean> {
  return record !== null && tokenCanAccess(record, scope, now) && verifySecret(secret, pepper, record.secretHash)
}

// Validates a POST /api/v1/tokens body. Throws ValidationError (400) for any malformed input.
export function parseTokenRequest(value: unknown, now = new Date()): { scopes: PlanScope[]; expiresAt: Date } {
  const body = requireJsonObject(value)
  const scopes = body.scopes
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope): scope is PlanScope => typeof scope === "string" && isPlanScope(scope))) throw new ValidationError("Invalid token scopes")
  const expiresAt = new Date(typeof body.expiresAt === "string" ? body.expiresAt : "")
  if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= now) throw new ValidationError("Invalid token expiration")
  if (expiresAt.valueOf() - now.valueOf() > MAX_TOKEN_LIFETIME_MS) throw new ValidationError("Token expiration must be at most 90 days from now")
  return { scopes: [...new Set(scopes)], expiresAt }
}

export type TokenListRow = {
  id: string
  scopes: PlanScope[]
  expires_at: string | Date
  revoked_at: string | Date | null
  last_used_at: string | Date | null
  created_at: string | Date | null
}

const optionalDate = (value: string | Date | null) => value === null ? null : new Date(value)

// Maps a cli_tokens row to the public listing. Builds a fresh object so no other column
// (in particular secret_hash) can pass through.
export function tokenSummaryFromRow(row: TokenListRow): TokenSummary {
  return {
    id: row.id,
    scopes: row.scopes,
    expiresAt: new Date(row.expires_at),
    revokedAt: optionalDate(row.revoked_at),
    lastUsedAt: optionalDate(row.last_used_at),
    createdAt: optionalDate(row.created_at),
  }
}
