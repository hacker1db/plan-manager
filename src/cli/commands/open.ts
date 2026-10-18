// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { getPort } from '../../lib/config.js'
import { initStorage, resolveByIdOrSlug } from '../../lib/storage.js'
import { buildUrl } from '../../lib/envelope.js'
import { ensureService } from '../../lib/service.js'
import { EXIT } from '../exit.js'
import { getSite } from './remote.js'

export async function cmdOpen(args, opts) {
  if (opts.remote) {
    const url = getSite().url
    const opener = process.env.PLAN_BROWSER ?? (process.platform === 'darwin' ? 'open' : 'xdg-open')
    const result = spawnSync(opener, [url], { stdio: 'inherit' })
    if (result.error) {
      process.stderr.write(`Could not open browser: ${result.error.message}\n`)
      process.stdout.write(`Plan Manager: ${url}\n`)
    }
    return
  }

  const port = getPort()
  let url = `http://plans.localhost:${port}`

  if (args.length > 0) {
    const idOrSlug = args[0]
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
    url = buildUrl(resolved.meta.id)
  }

  try {
    await ensureService()
  } catch (err) {
    process.stderr.write(`Could not start plan dashboard: ${err.message}\n`)
    process.exit(err.code === 'EADDRINUSE' ? EXIT.PORT_COLLISION : EXIT.DEPENDENCY_UNAVAILABLE)
  }

  const opener = process.env.PLAN_BROWSER ?? (process.platform === 'darwin' ? 'open' : 'xdg-open')
  const result = spawnSync(opener, [url], { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`Could not open browser: ${result.error.message}\n`)
    process.stdout.write(`Dashboard: ${url}\n`)
  }
}
