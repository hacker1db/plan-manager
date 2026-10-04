// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { initStorage, uniqueSlug, planPath } from '../../lib/storage.js'
import { generateId, slugify } from '../../lib/ids.js'
import { writePlan, readPlan, parseFrontmatter, normalizeMeta } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

export async function cmdCreate(args, opts) {
  const title = opts.title
  if (!title) {
    process.stderr.write('Error: --title is required\n  Usage: plan create --title <title> [--stdin|--file <file>] [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }

  let body = ''
  if (opts.stdin) {
    const raw = await readStdin()
    const { meta: fm, body: b } = parseFrontmatter(raw)
    body = Object.keys(fm).length > 0 ? b : raw
  } else if (opts.file) {
    const raw = await readFile(opts.file, 'utf8').catch(err => {
      process.stderr.write(`Error reading file: ${err.message}\n`)
      process.exit(EXIT.INVALID_INPUT)
    })
    const { meta: fm, body: b } = parseFrontmatter(raw)
    body = Object.keys(fm).length > 0 ? b : raw
  }

  await initStorage()
  let envelope
  try {
    envelope = await withPlanWriteLock(async () => {
      const id = generateId()
      const base = slugify(title)
      const slug = await uniqueSlug(base)
      const fp = planPath(slug)
      const now = new Date().toISOString()
      const meta = normalizeMeta({ id, title, status: 'active', created: now, updated: now, tags: [] })
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
    process.stdout.write(`Created: ${envelope.path}\n  id: ${envelope.id}\n  url: ${envelope.url}\n`)
  }
}
