// @ts-nocheck
import { initStorage, resolveByIdOrSlug, containedPath } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { EXIT } from '../exit.js'

export async function cmdShow(args, opts) {
  const idOrSlug = args[0]
  if (!idOrSlug) {
    process.stderr.write('Error: id or slug required\n  Usage: plan show <id-or-slug> [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  await initStorage()
  let resolved
  try {
    resolved = await resolveByIdOrSlug(idOrSlug)
  } catch (err) {
    if (err.code === 'EAMBIGUOUS') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.AMBIGUOUS)
    }
    if (err.code === 'ENOTFOUND') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.NOT_FOUND)
    }
    throw err
  }
  if (!containedPath(resolved.filePath)) {
    process.stderr.write(`Error: path not contained in plan home\n`)
    process.exit(EXIT.PATH_TRAVERSAL)
  }
  const parsed = await readPlan(resolved.filePath)
  if (opts.json) {
    const envelope = await buildEnvelope(parsed)
    const out = { ...envelope, body: parsed.body }
    process.stdout.write(JSON.stringify(out) + '\n')
  } else {
    process.stdout.write(`# ${parsed.meta.title}\n`)
    process.stdout.write(`id: ${parsed.meta.id}  status: ${parsed.meta.status}\n`)
    process.stdout.write(`url: http://plans.localhost:4173/plans/${parsed.meta.id}\n\n`)
    process.stdout.write(parsed.body + '\n')
  }
}
