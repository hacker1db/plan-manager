// @ts-nocheck
import { rename } from 'node:fs/promises'
import { basename, dirname, normalize, resolve } from 'node:path'
import { initStorage, resolveByIdOrSlug, containedPath, archiveDir, uniqueArchivePath } from '../../lib/storage.js'
import { readPlan, writePlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'

export async function cmdArchive(args, opts) {
  const idOrSlug = args[0]
  if (!idOrSlug) {
    process.stderr.write('Error: id or slug required\n  Usage: plan archive <id-or-slug>\n')
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
      const slug = basename(resolved.filePath, '.md')
      if (normalize(resolve(dirname(resolved.filePath))) === normalize(resolve(archiveDir()))) {
        if (parsed.meta.status !== 'archived') {
          await writePlan(resolved.filePath, { ...parsed.meta, status: 'archived' }, parsed.body)
        }
        return {
          alreadyArchived: true,
          source: resolved.filePath,
          envelope: await buildEnvelope(await readPlan(resolved.filePath)),
        }
      }
      const dest = await uniqueArchivePath(slug)
      await writePlan(resolved.filePath, { ...parsed.meta, status: 'archived' }, parsed.body)
      await rename(resolved.filePath, dest)
      return {
        alreadyArchived: false,
        source: resolved.filePath,
        destination: dest,
        envelope: await buildEnvelope(await readPlan(dest)),
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
  if (result.alreadyArchived) {
    if (opts.json) process.stdout.write(JSON.stringify(envelope) + '\n')
    else process.stdout.write(`Already archived: ${result.source}\n`)
    return
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    process.stdout.write(`Archived: ${result.source} -> ${result.destination}\n`)
  }
}
