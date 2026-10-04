import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { PLAN_SCOPES, type CliToken, type PlanScope, type TokenRecord } from "./types"

const scrypt = promisify(rawScrypt)

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
