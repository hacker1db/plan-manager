// @ts-nocheck
import { lstat, readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { initStorage, uniqueSlug, planPath } from '../../lib/storage.js'
import { parseFrontmatter, normalizeMeta, writePlan, readPlan } from '../../lib/metadata.js'
import { generateId, slugify } from '../../lib/ids.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'

export async function cmdImport(args, opts) {
  const src = args[0]
  if (!src) {
    process.stderr.write('Error: file argument required\n  Usage: plan import <file>\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  const sourcePath = resolve(src)
  const extension = extname(sourcePath).toLowerCase()
  if (extension !== '.md' && extension !== '.markdown') {
    process.stderr.write('Error: plan import accepts only Markdown files; use plan capture for HTML artifacts\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  try {
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      process.stderr.write('Error: source must be a regular Markdown file\n')
      process.exit(EXIT.INVALID_INPUT)
    }
  } catch (err) {
    process.stderr.write(`Error reading source file: ${err.message}\n`)
    process.exit(EXIT.INVALID_INPUT)
  }
  let raw
  try {
    raw = await readFile(sourcePath, 'utf8')
  } catch (err) {
    process.stderr.write(`Error reading source file: ${err.message}\n`)
    process.exit(EXIT.INVALID_INPUT)
  }
  await initStorage()
  const { meta: rawMeta, body } = parseFrontmatter(raw)
  const title = rawMeta.title || basename(sourcePath, extension).replace(/-/g, ' ')
  const id = generateId()
  const now = new Date().toISOString()
  const meta = normalizeMeta({
    ...rawMeta,
    id,
    title,
    created: rawMeta.created ?? now,
    updated: now,
    source: sourcePath,
  })
  let envelope
  try {
    envelope = await withPlanWriteLock(async () => {
      const base = slugify(meta.title)
      const slug = await uniqueSlug(base)
      const fp = planPath(slug)
      await writePlan(fp, meta, body)
      return buildEnvelope(await readPlan(fp))
    })
  } catch (err) {
    if (err.code === 'ELOCKTIMEOUT') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.CONFLICT)
    }
    throw err
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    process.stdout.write(`Imported: ${sourcePath} -> ${envelope.path}\n  id: ${envelope.id}\n  url: ${envelope.url}\n`)
  }
}
