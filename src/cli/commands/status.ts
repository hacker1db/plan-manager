// @ts-nocheck
import { initStorage, resolveByIdOrSlug, containedPath } from '../../lib/storage.js'
import { readPlan, writePlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'

const VALID_STATUSES = new Set(['active', 'completed', 'archived'])

export async function cmdStatus(args, opts) {
  const [idOrSlug, newStatus] = args
  if (!idOrSlug || !newStatus) {
    process.stderr.write('Error: id/slug and status required\n  Usage: plan status <id-or-slug> <active|completed|archived>\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  if (!VALID_STATUSES.has(newStatus)) {
    process.stderr.write(`Error: invalid status "${newStatus}" (valid: active, completed, archived)\n`)
    process.exit(EXIT.INVALID_INPUT)
  }
  await initStorage()
  let result
  try {
    result = await withPlanWriteLock(async () => {
      const resolved = await resolveByIdOrSlug(idOrSlug)
      if (!containedPath(resolved.filePath)) {
        const pathError = new Error('Path not contained in plan home')
        pathError.code = 'EPATHTRAVERSAL'
        throw pathError
      }
      const parsed = await readPlan(resolved.filePath)
      await writePlan(resolved.filePath, { ...parsed.meta, status: newStatus }, parsed.body)
      return {
        previousStatus: parsed.meta.status,
        filePath: resolved.filePath,
        envelope: await buildEnvelope(await readPlan(resolved.filePath)),
      }
    })
  } catch (err) {
    if (err.code === 'EAMBIGUOUS') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.AMBIGUOUS)
    }
    if (err.code === 'ENOTFOUND') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.NOT_FOUND)
    }
    if (err.code === 'ELOCKTIMEOUT') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.CONFLICT)
    }
    if (err.code === 'EPATHTRAVERSAL') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.PATH_TRAVERSAL)
    }
    throw err
  }
  const { envelope } = result
  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    process.stdout.write(`Status updated: ${result.previousStatus} -> ${newStatus}\n  ${result.filePath}\n`)
  }
}
