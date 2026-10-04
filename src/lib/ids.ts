import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'

export function generateId(): string {
  return nanoid(21)
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'plan'
}

export async function computeRevision(content: string): Promise<string> {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
