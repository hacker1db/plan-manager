import { BlobNotFoundError, del, get, head, put } from "@vercel/blob"
import yaml from "js-yaml"
import { getHostedEnvironment } from "./env.ts"
import { getSql } from "./db.ts"
import { requirePlanId, sanitizeMarkdown, ValidationError } from "./sanitize.ts"
import { validatePlanUpload } from "./plan-input.ts"
import { writeValidatedPlan, type PlanWriteStore } from "./write-plan.ts"
import { computeRevision } from "../ids.ts"
import { isPlanStatus, type PlanStatus } from "../types.ts"
import { createStatusVersion } from "./status-version.ts"
import type { CliToken, HostedPlan, HostedPlanInput, PlanScope, TokenRecord, TokenSummary } from "../hosted/types.ts"
import { tokenSummaryFromRow, type TokenListRow } from "./token.ts"

type PlanRow = {
  id: string
  title: string
  status: "active" | "completed" | "archived"
  tags: string[]
  created_at: string | Date
  updated_at: string | Date
  revision: string
  object_key: string
}

type TokenRow = {
  id: string
  secret_hash: string
  scopes: PlanScope[]
  expires_at: string
  revoked_at: string | null
}

function planFromRow(row: PlanRow): HostedPlan {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    tags: row.tags,
    created: new Date(row.created_at).toISOString(),
    updated: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    objectKey: row.object_key,
  }
}

export async function listPlans(): Promise<HostedPlan[]> {
  const rows = await getSql()`SELECT id, title, status, tags, created_at, updated_at, revision, object_key FROM plans ORDER BY updated_at DESC` as unknown as PlanRow[]
  return rows.map(planFromRow)
}

export async function findPlan(id: string): Promise<HostedPlan | null> {
  const planId = requirePlanId(id)
  const rows = await getSql()`SELECT id, title, status, tags, created_at, updated_at, revision, object_key FROM plans WHERE id = ${planId} LIMIT 1` as unknown as PlanRow[]
  return rows[0] ? planFromRow(rows[0]) : null
}

export async function readMarkdown(plan: HostedPlan): Promise<string> {
  const blob = await get(plan.objectKey, { access: "private", token: getHostedEnvironment().blobReadWriteToken })
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error("Plan content is unavailable")
  return sanitizeMarkdown(await new Response(blob.stream).text())
}

// Real storage for the write sequence in write-plan.ts.
const planWriteStore: PlanWriteStore = {
  findPlan,
  async findVersionKey(id, revision) {
    const rows = await getSql()`SELECT object_key FROM plan_versions WHERE plan_id = ${id} AND revision = ${revision} LIMIT 1` as unknown as { object_key: string }[]
    return rows[0]?.object_key ?? null
  },
  async blobExists(objectKey) {
    try {
      await head(objectKey, { token: getHostedEnvironment().blobReadWriteToken })
      return true
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false
      throw error
    }
  },
  async putBlob(objectKey, markdown) {
    await put(objectKey, markdown, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "text/markdown; charset=utf-8",
      token: getHostedEnvironment().blobReadWriteToken,
    })
  },
  async deleteBlob(objectKey) {
    await del(objectKey, { token: getHostedEnvironment().blobReadWriteToken })
  },
  async upsertPlan(normalized, objectKey) {
    const rows = await getSql()`
      INSERT INTO plans (id, title, status, tags, created_at, updated_at, revision, object_key)
      VALUES (${normalized.id}, ${normalized.title}, ${normalized.status}, ${JSON.stringify(normalized.tags)}::jsonb, ${normalized.created}, ${normalized.updated}, ${normalized.revision}, ${objectKey})
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        updated_at = EXCLUDED.updated_at,
        revision = EXCLUDED.revision,
        object_key = EXCLUDED.object_key
      WHERE plans.revision = ${normalized.expectedRevision}
      RETURNING id, title, status, tags, created_at, updated_at, revision, object_key
    ` as unknown as PlanRow[]
    return rows[0] ? planFromRow(rows[0]) : null
  },
  async recordVersion(id, revision, objectKey) {
    await getSql()`INSERT INTO plan_versions (plan_id, revision, object_key, created_at) VALUES (${id}, ${revision}, ${objectKey}, NOW()) ON CONFLICT (plan_id, revision) DO NOTHING`
  },
}

export async function writePlan(input: HostedPlanInput): Promise<{ plan: HostedPlan; conflict: boolean }> {
  return writeValidatedPlan(planWriteStore, await validatePlanUpload(input))
}

export async function updatePlanStatus(id: string, status: PlanStatus): Promise<{ plan: HostedPlan | null; conflict: boolean }> {
  if (!isPlanStatus(status)) throw new ValidationError("Invalid plan status")
  const existing = await findPlan(id)
  if (!existing) return { plan: null, conflict: false }
  if (existing.status === status) return { plan: existing, conflict: false }

  const markdown = await readMarkdown(existing)
  const updated = new Date().toISOString()
  const { markdown: nextMarkdown, revision } = await createStatusVersion(markdown, existing, status, updated)
  return writePlan({
    ...existing,
    status,
    updated,
    markdown: nextMarkdown,
    revision,
    expectedRevision: existing.revision,
  })
}

export async function findToken(id: string): Promise<TokenRecord | null> {
  const rows = await getSql()`SELECT id, secret_hash, scopes, expires_at, revoked_at FROM cli_tokens WHERE id = ${id} LIMIT 1` as unknown as TokenRow[]
  const row = rows[0]
  return row ? { id: row.id, secretHash: row.secret_hash, scopes: row.scopes, expiresAt: new Date(row.expires_at), revokedAt: row.revoked_at ? new Date(row.revoked_at) : null } : null
}

export async function createToken(record: TokenRecord): Promise<CliToken> {
  await getSql()`INSERT INTO cli_tokens (id, secret_hash, scopes, expires_at, created_at) VALUES (${record.id}, ${record.secretHash}, ${JSON.stringify(record.scopes)}::jsonb, ${record.expiresAt.toISOString()}, NOW())`
  return { id: record.id, scopes: record.scopes, expiresAt: record.expiresAt, revokedAt: null }
}

export async function revokeToken(id: string): Promise<boolean> {
  const rows = await getSql()`UPDATE cli_tokens SET revoked_at = NOW() WHERE id = ${id} AND revoked_at IS NULL RETURNING id` as unknown as { id: string }[]
  return Boolean(rows[0])
}

// Owner token listing. Selects only the public columns; secret_hash is never read here.
export async function listTokens(): Promise<TokenSummary[]> {
  const rows = await getSql()`SELECT id, scopes, expires_at, revoked_at, last_used_at, created_at FROM cli_tokens ORDER BY created_at DESC NULLS LAST, id` as unknown as TokenListRow[]
  return rows.map(tokenSummaryFromRow)
}

export async function touchToken(id: string): Promise<void> {
  await getSql()`UPDATE cli_tokens SET last_used_at = NOW() WHERE id = ${id}`
}
