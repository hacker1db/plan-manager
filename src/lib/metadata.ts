import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { atomicWrite } from './storage.js'
import { generateId } from './ids.js'
import { PLAN_STATUSES, type ParsedPlan, type PlanMetadata, type PlanStatus, type UnknownRecord } from './types.js'

const STATUS_VALUES = new Set<PlanStatus>(PLAN_STATUSES)

export function parseFrontmatter(content: string): { meta: UnknownRecord; body: string } {
  if (!content.startsWith('---')) {
    return { meta: {}, body: content }
  }
  const end = content.indexOf('\n---', 3)
  if (end === -1) {
    return { meta: {}, body: content }
  }
  const yamlText = content.slice(3, end).trim()
  const body = content.slice(end + 4).replace(/^\n/, '')
  let meta: UnknownRecord = {}
  try {
    const parsed = yaml.load(yamlText)
    meta = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : {}
  } catch {
    meta = {}
  }
  return { meta, body }
}

export function normalizeMeta(raw: UnknownRecord, _filePath?: string): PlanMetadata {
  const now = new Date().toISOString()
  const status = typeof raw.status === 'string' && STATUS_VALUES.has(raw.status as PlanStatus)
    ? raw.status as PlanStatus
    : 'active'
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : generateId(),
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : 'Untitled',
    status,
    created: typeof raw.created === 'string' ? raw.created : now,
    updated: typeof raw.updated === 'string' ? raw.updated : now,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    ...(raw.source != null ? { source: String(raw.source) } : {}),
  }
}

export async function readPlan(filePath: string): Promise<ParsedPlan> {
  const raw = await readFile(filePath, 'utf8')
  const { meta: rawMeta, body } = parseFrontmatter(raw)
  const meta = normalizeMeta(rawMeta, filePath)
  return { meta, body, raw, filePath }
}

export async function writePlan(filePath: string, meta: PlanMetadata, body: string): Promise<void> {
  const updated = { ...meta, updated: new Date().toISOString() }
  const frontmatter = yaml.dump(updated, { lineWidth: -1 }).trimEnd()
  const content = `---\n${frontmatter}\n---\n${body.startsWith('\n') ? body : '\n' + body}`
  await atomicWrite(filePath, content)
}
