// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { initStorage, uniqueSlug, planPath } from '../../lib/storage.js'
import { generateId, slugify } from '../../lib/ids.js'
import { writePlan, readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'
import { requestedFormat } from '../format-option.js'

export async function cmdNew(args, opts) {
  const title = args.join(' ').trim()
  if (!title) {
    process.stderr.write('Error: title required\n  Usage: plan new <title> [--format md|mdx]\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  const format = requestedFormat(opts, 'md')
  await initStorage()
  let fp
  try {
    fp = await withPlanWriteLock(async () => {
      const id = generateId()
      const base = slugify(title)
      const slug = await uniqueSlug(base)
      const filePath = planPath(slug, format)
      const meta = {
        id,
        title,
        status: 'active',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        tags: [],
      }
      await writePlan(filePath, meta, '')
      return filePath
    })
  } catch (err) {
    if (err.code === 'ELOCKTIMEOUT') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.CONFLICT)
    }
    throw err
  }
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
  const result = spawnSync(editor, [fp], { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`Warning: could not open editor "${editor}": ${result.error.message}\n`)
  }
  const parsed = await readPlan(fp)
  const envelope = await buildEnvelope(parsed)
  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    process.stdout.write(`Created: ${fp}\n  id: ${envelope.id}\n  url: ${envelope.url}\n`)
  }
}
