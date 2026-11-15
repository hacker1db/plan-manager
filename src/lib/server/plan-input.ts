import { computeRevision } from "../ids.ts"
import { parseFrontmatter } from "../metadata.ts"
import { isPlanStatus } from "../types.ts"
import type { HostedPlanInput } from "../hosted/types.ts"
import { requirePlanId, requireRevision, safeTags, safeText, sanitizeMarkdown, ValidationError } from "./sanitize.ts"

// Pure validation for an uploaded plan version (no database or Blob access), so it can be tested
// directly. The server never trusts the client's revision or metadata:
//
// - revision must be the SHA-256 of the Markdown exactly as stored (after CRLF -> LF
//   normalization). The Go CLI normalizes and hashes the same bytes (remote.PushPayload.Normalized).
// - title, status, tags, created (and id) must agree with the Markdown's own frontmatter.
//   Mismatches are rejected with 400 rather than silently overridden, so a client bug or a forged
//   request cannot store a plan whose list metadata disagrees with its content.
//
// Absent or invalid frontmatter fields are compared against the defaults the Go CLI derives for
// them (cli/internal/plans/meta.go NormalizeMeta): title "Untitled", status "active", tags [].
// An absent `created` cannot be checked (the CLI substitutes the current time) and is accepted.

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString()
  return undefined
}

function isoTimestamp(value: unknown): string | undefined {
  const text = scalar(value)
  if (text === undefined) return undefined
  const date = new Date(text)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function frontmatterTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags = value.map(scalar).filter((tag): tag is string => tag !== undefined).map(tag => tag.trim())
  return [...new Set(tags)]
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

// Throws ValidationError naming the disagreeing fields; never echoes values.
export function assertMetadataMatchesFrontmatter(input: Pick<HostedPlanInput, "id" | "title" | "status" | "tags" | "created" | "markdown">): void {
  const { meta } = parseFrontmatter(input.markdown)
  const mismatched: string[] = []

  const id = scalar(meta.id)
  if (id !== undefined && id !== "" && id !== input.id) mismatched.push("id")

  const title = scalar(meta.title)
  const expectedTitle = title !== undefined && title !== "" ? title.trim() : "Untitled"
  if (expectedTitle !== input.title) mismatched.push("title")

  const status = scalar(meta.status)
  const expectedStatus = status !== undefined && isPlanStatus(status) ? status : "active"
  if (expectedStatus !== input.status) mismatched.push("status")

  if (!sameList(frontmatterTags(meta.tags), input.tags)) mismatched.push("tags")

  if (meta.created !== undefined && meta.created !== null) {
    const created = isoTimestamp(meta.created)
    if (created !== input.created) mismatched.push("created")
  }

  if (mismatched.length > 0) throw new ValidationError(`Plan metadata does not match its frontmatter: ${mismatched.join(", ")}`)
}

export async function validatePlanUpload(value: HostedPlanInput): Promise<HostedPlanInput> {
  const status = value.status
  if (!isPlanStatus(status)) throw new ValidationError("Invalid plan status")
  const created = new Date(value.created)
  const updated = new Date(value.updated)
  if (Number.isNaN(created.valueOf()) || Number.isNaN(updated.valueOf())) throw new ValidationError("Invalid plan timestamp")
  const normalized: HostedPlanInput = {
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
  if (await computeRevision(normalized.markdown) !== normalized.revision) throw new ValidationError("Revision does not match the SHA-256 of the Markdown")
  assertMetadataMatchesFrontmatter(normalized)
  return normalized
}
