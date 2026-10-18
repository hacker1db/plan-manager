// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { getPort } from '../../lib/config.js'
import { initStorage, resolveByIdOrSlug } from '../../lib/storage.js'
import { buildUrl } from '../../lib/envelope.js'
import { ensureService } from '../../lib/service.js'
import { getSite, tokenFromKeychain } from './remote.js'
import { EXIT } from '../exit.js'

async function resolvePlan(idOrSlug) {
  await initStorage()
  try {
    return await resolveByIdOrSlug(idOrSlug)
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
}

function openInBrowser(url, label) {
  const opener = process.env.PLAN_BROWSER ?? (process.platform === 'darwin' ? 'open' : 'xdg-open')
  const result = spawnSync(opener, [url], { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`Could not open browser: ${result.error.message}\n`)
    process.stdout.write(`${label}: ${url}\n`)
  }
}

async function openLocalhost(args) {
  const port = getPort()
  let url = `http://plans.localhost:${port}`

  if (args.length > 0) {
    const resolved = await resolvePlan(args[0])
    url = buildUrl(resolved.meta.id)
  }

  try {
    await ensureService()
  } catch (err) {
    process.stderr.write(`Could not start plan dashboard: ${err.message}\n`)
    process.exit(err.code === 'EADDRINUSE' ? EXIT.PORT_COLLISION : EXIT.DEPENDENCY_UNAVAILABLE)
  }

  openInBrowser(url, 'Dashboard')
}

export async function cmdOpen(args, opts) {
  if (opts.localhost) return openLocalhost(args)

  const site = getSite()
  let url = site.url
  if (args.length > 0) {
    const resolved = await resolvePlan(args[0])
    url = `${site.url}/plans/${resolved.meta.id}`
  }

  try {
    await tokenFromKeychain()
  } catch {
    process.stderr.write(`Not signed in to ${site.url}. Run "plan auth login" to sign in, or "plan --localhost" to open the local dashboard.\n`)
    process.exit(EXIT.DEPENDENCY_UNAVAILABLE)
  }

  try {
    await fetch(`${site.url}/api/v1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  } catch {
    process.stderr.write(`Cannot reach ${site.url}. Check your connection, or run "plan --localhost" to open the local dashboard.\n`)
    process.exit(EXIT.DEPENDENCY_UNAVAILABLE)
  }

  openInBrowser(url, 'Plan Manager')
}
