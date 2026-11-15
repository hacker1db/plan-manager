// A client sent a malformed request. apiError maps it to 400 with this message, so messages
// name the problem (and at most a code-supplied field name) and never echo the input.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

const MAX_MARKDOWN_BYTES = 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const REVISION_PATTERN = /^[a-f0-9]{64}$/

export function requirePlanId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError("Invalid plan id")
  return value
}

export function requireRevision(value: unknown): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) throw new ValidationError("Invalid revision")
  return value
}

export function sanitizeMarkdown(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Markdown must be a string")
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes === 0 || bytes > MAX_MARKDOWN_BYTES) throw new ValidationError("Markdown must be between 1 byte and 1 MiB")
  if (value.includes("\u0000")) throw new ValidationError("Markdown cannot contain null bytes")
  return value.replace(/\r\n/g, "\n")
}

export function safeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength || /[\u0000-\u001f]/.test(trimmed)) throw new ValidationError(`Invalid ${field}`)
  return trimmed
}

export function safeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new ValidationError("Invalid tags")
  return [...new Set(value.map(tag => safeText(tag, "tag", 64)))]
}

// Rejects JSON bodies that are not a plain object (null, arrays, numbers, strings, booleans).
export function requireJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Request body must be a JSON object")
  return value as Record<string, unknown>
}
