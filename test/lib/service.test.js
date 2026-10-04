import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeService } from '../../dist/lib/service.js'

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(server.address().port)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('probeService identifies the plan-manager health contract', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      service: 'plan-manager',
      version: 1,
      status: 'ok',
      planHome: '/tmp/plans',
    }))
  }, async port => {
    const result = await probeService({ port, planHome: '/tmp/plans' })
    assert.equal(result.serviceState, 'running')
    assert.equal(result.owned, true)
  })
})

test('probeService reports a non-plan listener as an error', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('not plan-manager')
  }, async port => {
    const result = await probeService({ port, planHome: '/tmp/plans' })
    assert.equal(result.serviceState, 'error')
    assert.equal(result.owned, false)
  })
})

test('probeService reports a stopped service when the connection is refused', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const result = await probeService({ port, planHome: '/tmp/plans' })
  assert.equal(result.serviceState, 'stopped')
})
