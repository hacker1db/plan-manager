export const PLAN_STATUSES = ['active', 'completed', 'archived'] as const
export type PlanStatus = typeof PLAN_STATUSES[number]
export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value)
}
export interface PlanMetadata { id: string; title: string; status: PlanStatus; created: string; updated: string; tags: string[]; source?: string; format?: 'mdx' }
export type UnknownRecord = Record<string, unknown>
export interface ParsedPlan { meta: PlanMetadata; body: string; raw: string; filePath: string }
export interface PlanEnvelope { version: 1; id: string; title: string; status: PlanStatus; path: string; url: string; revision: string; created: string; updated: string; tags: string[] }
export interface CliOptions { json?: boolean; stdin?: boolean; foreground?: boolean; remote?: string | boolean; token?: string; title?: string; file?: string; format?: string; status?: string; ifRevision?: string }
