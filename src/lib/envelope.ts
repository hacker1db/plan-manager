import { getPort } from './config.js'
import { computeRevision } from './ids.js'
import { safeStage } from './tracking.js'
import type { ParsedPlan, PlanEnvelope } from './types.js'

export function buildUrl(id: string): string {
  const port = getPort()
  return `http://plans.localhost:${port}/plans/${id}`
}

export async function buildEnvelope(parsedPlan: ParsedPlan): Promise<PlanEnvelope> {
  const { meta, raw, filePath } = parsedPlan
  const revision = await computeRevision(raw)
  return {
    version: 1 as const,
    id: meta.id,
    title: meta.title,
    status: meta.status,
    path: filePath,
    url: buildUrl(meta.id),
    revision,
    created: meta.created,
    updated: meta.updated,
    tags: meta.tags,
    stage: safeStage(meta),
  }
}
