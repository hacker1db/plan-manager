export const PLAN_STATUSES = ['active', 'completed', 'archived'] as const
export type PlanStatus = typeof PLAN_STATUSES[number]
export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value)
}
export interface PlanMetadata {
  id: string; title: string; status: PlanStatus; created: string; updated: string; tags: string[]; source?: string; format?: 'mdx'
  schemaVersion?: number
  // Raw tracking frontmatter, validated by the plan CLI (cli/internal/tracking).
  tracking?: unknown
  // Unknown frontmatter fields are kept so newer writers' metadata survives a round trip.
  [field: string]: unknown
}
export type UnknownRecord = Record<string, unknown>
