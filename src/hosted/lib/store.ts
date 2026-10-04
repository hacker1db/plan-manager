import { del, get, put } from "@vercel/blob"
import yaml from "js-yaml"
import { getHostedEnvironment } from "./env"
import { getSql } from "./db"
import { requirePlanId, requireRevision, safeTags, safeText, sanitizeMarkdown } from "./sanitize"
import { computeRevision } from "@/lib/ids"
import { isPlanStatus, type PlanStatus } from "@/lib/types"
import { createStatusVersion } from "./status-version"
import type { CliToken, HostedPlan, HostedPlanInput, PlanScope, TokenRecord } from "./types"

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

function normalizeInput(value: HostedPlanInput): HostedPlanInput {
  const status = value.status
  if (!["active", "completed", "archived"].includes(status)) throw new Error("Invalid plan status")
  const created = new Date(value.created)
  const updated = new Date(value.updated)
  if (Number.isNaN(created.valueOf()) || Number.isNaN(updated.valueOf())) throw new Error("Invalid plan timestamp")
  return {
    id: requirePlanId(value.id),
    title: safeText(value.title, "title", 256),
    status,
    tags: safeTags(value.tags),
    created: created.toISOString(),
    updated: updated.toISOString(),
    markdown: sanitizeMarkdown(value.markdown),
    revision: requireRevision(value.revision),
    expectedRevision: value.expectedRevision === null ? null : requireRevision(value.expectedRevision),
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

export async function writePlan(input: HostedPlanInput): Promise<{ plan: HostedPlan; conflict: boolean }> {
  const normalized = normalizeInput(input)
  const existing = await findPlan(normalized.id)
  if (existing?.revision === normalized.revision) return { plan: existing, conflict: false }
  if ((existing?.revision ?? null) !== normalized.expectedRevision) return { plan: existing ?? null as never, conflict: true }
  const objectKey = `plans/${normalized.id}/${normalized.revision}.md`
  await put(objectKey, normalized.markdown, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "text/markdown; charset=utf-8",
    token: getHostedEnvironment().blobReadWriteToken,
  })
  try {
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
    if (!rows[0]) return { plan: (await findPlan(normalized.id))!, conflict: true }
    await getSql()`INSERT INTO plan_versions (plan_id, revision, object_key, created_at) VALUES (${normalized.id}, ${normalized.revision}, ${objectKey}, NOW()) ON CONFLICT (plan_id, revision) DO NOTHING`
    return { plan: planFromRow(rows[0]), conflict: false }
  } catch (error) {
    await del(objectKey, { token: getHostedEnvironment().blobReadWriteToken }).catch(() => undefined)
    throw error
  }
}

export async function updatePlanStatus(id: string, status: PlanStatus): Promise<{ plan: HostedPlan | null; conflict: boolean }> {
  if (!isPlanStatus(status)) throw new Error("Invalid plan status")
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
  await getSql()`INSERT INTO cli_tokens (id, secret_hash, scopes, expires_at) VALUES (${record.id}, ${record.secretHash}, ${JSON.stringify(record.scopes)}::jsonb, ${record.expiresAt.toISOString()})`
  return { id: record.id, scopes: record.scopes, expiresAt: record.expiresAt, revokedAt: null }
}

export async function revokeToken(id: string): Promise<boolean> {
  const rows = await getSql()`UPDATE cli_tokens SET revoked_at = NOW() WHERE id = ${id} AND revoked_at IS NULL RETURNING id` as unknown as { id: string }[]
  return Boolean(rows[0])
}
