// @ts-nocheck
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initStorage, resolveByIdOrSlug } from '../../lib/storage.js'
import { formatFromPath, sourceFormat, stripFrontmatter } from '../../lib/mdx/format.js'
import { checkMdx } from '../../lib/mdx/html.js'
import { EXIT } from '../exit.js'

async function locate(target) {
  const candidate = resolve(target)
  try {
    if ((await lstat(candidate)).isFile()) return candidate
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  await initStorage()
  return (await resolveByIdOrSlug(target)).filePath
}

export async function cmdCheck(args, opts) {
  if (args.length === 0) {
    process.stderr.write('Error: file, id, or slug required\n  Usage: plan check <file|id-or-slug>... [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  const results = []
  for (const target of args) {
    let filePath
    try {
      filePath = await locate(target)
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(err.code === 'EAMBIGUOUS' ? EXIT.AMBIGUOUS : EXIT.NOT_FOUND)
    }
    const raw = await readFile(filePath, 'utf8')
    const format = formatFromPath(filePath) === 'mdx' || sourceFormat(raw) === 'mdx' ? 'mdx' : 'md'
    const problems = format === 'mdx' ? checkMdx(stripFrontmatter(raw)) : []
    results.push({ path: filePath, format, ok: problems.length === 0, problems })
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ version: 1, results }) + '\n')
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? 'ok' : 'FAIL'}  ${result.path}${result.format === 'md' ? ' (Markdown, nothing to check)' : ''}\n`)
      for (const problem of result.problems) process.stdout.write(`  - ${problem}\n`)
    }
  }
  if (results.some(result => !result.ok)) process.exit(EXIT.INVALID_INPUT)
}
