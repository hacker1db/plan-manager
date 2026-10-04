// @ts-nocheck
import { EXIT } from '../exit.js'
import { getPort, getHost, getPlanHome } from '../../lib/config.js'
import { dashboardUrl, ensureService } from '../../lib/service.js'

export async function cmdServe(args, opts) {
  const port = getPort()
  const host = getHost()

  let startServer
  try {
    const serverPath = new URL('../../server/server.js', import.meta.url)
    const mod = await import(serverPath.href)
    startServer = mod.startServer
  } catch (err) {
    process.stderr.write(`Error: server module not available (${err.message})\nRun "plan doctor" to diagnose.\n`)
    process.exit(EXIT.DEPENDENCY_UNAVAILABLE)
  }

  if (opts.foreground) {
    try {
      const { url, close } = await startServer({ port, host })
      const envelope = {
        version: 1,
        dashboardUrl: url,
        serviceState: 'running',
        port,
        host,
        planHome: getPlanHome(),
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n')
      } else {
        process.stdout.write(`Plan dashboard running at ${url}\n`)
      }
      process.on('SIGINT', async () => { await close(); process.exit(0) })
      process.on('SIGTERM', async () => { await close(); process.exit(0) })
      await new Promise(() => {})
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`Error: port ${port} is already in use. Run "plan doctor" for details.\n`)
        process.exit(EXIT.PORT_COLLISION)
      }
      throw err
    }
  } else {
    try {
      const service = await ensureService({ port, host, planHome: getPlanHome() })
      const envelope = {
        version: 1,
        dashboardUrl: service.dashboardUrl,
        serviceState: service.serviceState,
        started: service.started,
        port,
        host,
        ...(service.pid ? { pid: service.pid } : {}),
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n')
      } else {
        process.stdout.write(`Plan dashboard ${service.started ? 'started' : 'running'} at ${service.dashboardUrl}\n`)
      }
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`Error: ${err.message}\n`)
        process.exit(EXIT.PORT_COLLISION)
      }
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.DEPENDENCY_UNAVAILABLE)
    }
  }
}
