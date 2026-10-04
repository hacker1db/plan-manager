// @ts-nocheck
import { initStorage, listPlanFiles, listArchiveFiles } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { EXIT } from '../exit.js'

export async function cmdList(args, opts) {
  await initStorage()
  let files = await listPlanFiles()
  if (opts.status === 'archived') {
    files = await listArchiveFiles()
  } else if (opts.status === 'all') {
    const arc = await listArchiveFiles()
    files = [...files, ...arc]
  }

  const plans = []
  for (const f of files) {
    let parsed
    try { parsed = await readPlan(f) } catch { continue }
    if (opts.status && opts.status !== 'all' && opts.status !== 'archived') {
      if (parsed.meta.status !== opts.status) continue
    }
    plans.push(parsed)
  }

  if (opts.json) {
    const envelopes = await Promise.all(plans.map(p => buildEnvelope(p)))
    process.stdout.write(JSON.stringify({ version: 1, plans: envelopes }) + '\n')
  } else {
    if (plans.length === 0) {
      process.stdout.write('No plans found.\n')
      return
    }
    for (const p of plans) {
      const tags = p.meta.tags.length > 0 ? ` [${p.meta.tags.join(', ')}]` : ''
      process.stdout.write(`${p.meta.id}  ${p.meta.status.padEnd(10)}  ${p.meta.title}${tags}\n`)
    }
  }
}
