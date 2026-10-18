import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

async function withEnv(fn, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-health-cli-'))
  const env = { ...process.env, PLAN_HOME: join(dir, 'plans'), XDG_CONFIG_HOME: join(dir, 'config'), ...extraEnv }
  const plan = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input })
  try {
    assert.equal(plan(['create', '--title', 'Tracked', '--json']).status, 0)
    await fn({ plan })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const json = result => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const attach = plan => json(plan(['session', 'attach', 'tracked', '--stdin', '--json'], JSON.stringify({ provider: 'claude' }))).executionId

test('heartbeat records health, coalesces repeats and shows in plan show --json', async () => {
  await withEnv(async ({ plan }) => {
    const id = attach(plan)
    const before = json(plan(['show', 'tracked', '--json']))
    assert.equal(before.tracking.executions[0].health.freshness, 'unknown', 'manual sessions without heartbeats stay valid')
    assert.equal(before.tracking.staleMs, 20 * 60_000)
    const first = json(plan(['session', 'heartbeat', 'tracked', id, '--observed-at', '2020-01-01T00:00:00.000Z', '--json']))
    assert.equal(first.coalesced, false)
    assert.equal(first.event.type, 'session.heartbeat')
    const repeat = json(plan(['session', 'heartbeat', 'tracked', id, '--json']))
    assert.equal(repeat.coalesced, true)
    assert.equal(repeat.revision, first.revision)
    assert.equal(json(plan(['session', 'heartbeat', 'tracked', id, '--activity', 'idle', '--json'])).coalesced, false)
    const shown = json(plan(['show', 'tracked', '--json']))
    const health = shown.tracking.executions[0].health
    assert.equal(health.activity, 'idle')
    assert.equal(health.freshness, 'fresh')
    assert.equal(health.staleMs, 20 * 60_000)
    assert.equal(shown.stage, 'planning')
    assert.equal(typeof shown.body, 'string')
  }, { PLAN_STALE_MINUTES: '20' })
})

test('blocked needs reason and owner; ended sessions reject heartbeats', async () => {
  await withEnv(async ({ plan }) => {
    const id = attach(plan)
    assert.equal(plan(['session', 'heartbeat', 'tracked', id, '--activity', 'blocked', '--reason', 'keys']).status, 2)
    assert.equal(plan(['session', 'heartbeat', 'tracked', id, '--activity', 'offline']).status, 2)
    const blocked = json(plan(['session', 'heartbeat', 'tracked', id, '--activity', 'blocked', '--reason', 'keys', '--owner', 'alice', '--next', 'rotate', '--json']))
    assert.deepEqual(blocked.event.data, { executionId: id, activity: 'blocked', blockReason: 'keys', owner: 'alice', nextAction: 'rotate' })
    assert.equal(plan(['session', 'heartbeat', 'tracked', '00000000-0000-4000-8000-000000000000']).status, 3)
    json(plan(['session', 'end', 'tracked', id, '--json']))
    const rejected = plan(['session', 'heartbeat', 'tracked', id])
    assert.equal(rejected.status, 2)
    assert.match(rejected.stderr, /ended/)
    assert.equal(json(plan(['show', 'tracked', '--json'])).tracking.executions[0].health.activity, 'ended')
  })
})
