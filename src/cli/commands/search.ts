// @ts-nocheck
import { initStorage, allPlanFiles } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { EXIT } from '../exit.js'

export async function cmdSearch(args, opts) {
  const query = args.join(' ').trim().toLowerCase()
  if (!query) {
    process.stderr.write('Error: query required\n  Usage: plan search <query> [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  await initStorage()
  const files = await allPlanFiles()
  const results = []
  for (const f of files) {
    let parsed
    try { parsed = await readPlan(f) } catch { continue }
    const haystack = [
      parsed.meta.title,
      ...parsed.meta.tags,
      parsed.body,
    ].join(' ').toLowerCase()
    if (haystack.includes(query)) {
      results.push(parsed)
    }
  }
  if (opts.json) {
    const envelopes = await Promise.all(results.map(p => buildEnvelope(p)))
    process.stdout.write(JSON.stringify({ version: 1, query, plans: envelopes }) + '\n')
  } else {
    if (results.length === 0) {
      process.stdout.write(`No plans match "${query}".\n`)
      return
    }
    for (const p of results) {
      process.stdout.write(`${p.meta.id}  ${p.meta.title}\n`)
    }
  }
}
