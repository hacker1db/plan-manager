import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

// The installed `plan` CLI keeps its background service on the default port
// (4173), so the dev server picks a free port once, before `tsx watch` starts,
// and keeps it stable across watch restarts. Set PLAN_PORT to pin a port.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const port = process.env.PLAN_PORT ?? String(await freePort())
const child = spawn('tsx', ['watch', 'scripts/dev.mts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PLAN_PORT: port },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
