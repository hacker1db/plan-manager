// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { initStorage, resolveByIdOrSlug, containedPath } from '../../lib/storage.js'
import { readPlan, writePlan, parseFrontmatter } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { assertRevision } from '../../lib/revisions.js'
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

export async function cmdUpdate(args, opts) {
  const idOrSlug = args[0]
  if (!idOrSlug) {
    process.stderr.write('Error: id or slug required\n  Usage: plan update <id-or-slug> [--stdin|--file <file>] [--if-revision <rev>] [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  await initStorage()
  let newBody
  if (opts.stdin) {
    const raw = await readStdin()
    const { body } = parseFrontmatter(raw)
    newBody = body
  } else if (opts.file) {
    const raw = await readFile(opts.file, 'utf8').catch(err => {
      process.stderr.write(`Error reading file: ${err.message}\n`)
      process.exit(EXIT.INVALID_INPUT)
    })
    const { body } = parseFrontmatter(raw)
    newBody = body
  } else {
    process.stderr.write('Error: --stdin or --file required\n')
    process.exit(EXIT.INVALID_INPUT)
  }

  let result
  try {
    result = await withPlanWriteLock(async () => {
      const resolved = await resolveByIdOrSlug(idOrSlug)
      if (!containedPath(resolved.filePath)) {
        const pathError = new Error('Path not contained in plan home')
        pathError.code = 'EPATHTRAVERSAL'
        throw pathError
      }
      if (opts.ifRevision) await assertRevision(resolved.filePath, opts.ifRevision)
      const parsed = await readPlan(resolved.filePath)
      await writePlan(resolved.filePath, parsed.meta, newBody)
      return {
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
    if (err.code === 'ECONFLICT') {
      process.stderr.write(JSON.stringify({ error: 'conflict', currentRevision: err.currentRevision, suppliedRevision: err.suppliedRevision }) + '\n')
      process.exit(EXIT.CONFLICT)
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
    process.stdout.write(`Updated: ${result.filePath}\n  revision: ${envelope.revision}\n`)
  }
}
