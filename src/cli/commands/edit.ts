// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { initStorage, resolveByIdOrSlug, containedPath } from '../../lib/storage.js'
import { EXIT } from '../exit.js'

export async function cmdEdit(args, opts) {
  const idOrSlug = args[0]
  if (!idOrSlug) {
    process.stderr.write('Error: id or slug required\n  Usage: plan edit <id-or-slug>\n')
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
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
  const result = spawnSync(editor, [resolved.filePath], { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`Error: could not open editor "${editor}": ${result.error.message}\n`)
    process.exit(EXIT.GENERAL)
  }
}
