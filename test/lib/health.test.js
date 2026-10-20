import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, coalescesHeartbeat, executionHealth, projectTracking } from '../../dist/lib/tracking.js'

const META = { id: 'plan-1', title: 'Plan', status: 'active', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', tags: [] }
const A = '00000000-0000-4000-8000-00000000000a'
const execution = { id: A, provider: 'claude', nativeSessionId: null, role: 'implementation', machine: { installationId: A, displayName: 'Mac', hostname: 'Mac', os: 'darwin', arch: 'arm64' }, environment: { id: A, type: 'host' } }
const T0 = new Date('2026-01-01T10:00:00.000Z')
const at = minutes => new Date(T0.getTime() + minutes * 60_000)
const staleMs = 15 * 60_000

function attached() {
  return appendEvent(META, { type: 'session.attached', data: { execution }, actor: 't' }, T0).meta
}
function beat(meta, data, now = T0, observedAt) {
  return appendEvent(meta, { type: 'session.heartbeat', data: { executionId: A, ...data }, actor: 't', observedAt }, now).meta
}
const only = meta => projectTracking(meta).executions[0]

test('health is unknown without a heartbeat, fresh then stale with one, and never offline', () => {
  const manual = executionHealth(only(attached()), at(60), { staleMs })
  assert.equal(manual.freshness, 'unknown')
  assert.equal(manual.lastSeen, null)
  assert.equal(manual.activity, null)
  const meta = beat(attached(), { activity: 'idle' })
  assert.equal(executionHealth(only(meta), at(10), { staleMs }).freshness, 'fresh')
  const stale = executionHealth(only(meta), at(16), { staleMs })
  assert.equal(stale.freshness, 'stale')
  assert.equal(stale.activity, 'idle')
  assert.equal(stale.staleMs, staleMs)
  assert.equal(projectTracking(meta).stage, 'planning', 'health never changes stage')
})

test('clock skew compares observedAt with recordedAt', () => {
  const small = executionHealth(only(beat(attached(), { activity: 'active' }, T0, at(-2).toISOString())), T0, { staleMs })
  assert.equal(small.clockSkewMs, -120_000)
  assert.equal(small.clockSkewed, false)
  const big = executionHealth(only(beat(attached(), { activity: 'active' }, T0, at(6).toISOString())), T0, { staleMs })
  assert.equal(big.clockSkewed, true)
  assert.equal(executionHealth(only(beat(attached(), { activity: 'active' })), T0, { staleMs }).clockSkewMs, null)
})

test('blocked heartbeats require a reason and an owner', () => {
  assert.throws(() => beat(attached(), { activity: 'blocked', blockReason: 'keys' }), /blockReason and data.owner/)
  assert.throws(() => beat(attached(), { activity: 'offline' }), /data.activity/)
  const health = executionHealth(only(beat(attached(), { activity: 'blocked', blockReason: 'keys', owner: 'alice', nextAction: 'rotate' })), T0, { staleMs })
  assert.deepEqual([health.activity, health.blockReason, health.owner, health.nextAction], ['blocked', 'keys', 'alice', 'rotate'])
})

test('ended sessions report ended and ignore later heartbeats', () => {
  const ended = appendEvent(beat(attached(), { activity: 'active' }), { type: 'session.ended', data: { executionId: A }, actor: 't' }, at(1)).meta
  const execution = only(beat(ended, { activity: 'idle' }, at(2)))
  assert.equal(execution.heartbeat.activity, 'active')
  const health = executionHealth(execution, at(2), { staleMs })
  assert.equal(health.ended, true)
  assert.equal(health.activity, 'ended')
})

test('unchanged heartbeats coalesce inside the throttle window; changes always write', () => {
  const execution = only(beat(attached(), { activity: 'active' }))
  assert.equal(coalescesHeartbeat(execution, { activity: 'active' }, at(4)), true)
  assert.equal(coalescesHeartbeat(execution, { activity: 'active' }, at(5)), false)
  assert.equal(coalescesHeartbeat(execution, { activity: 'idle' }, at(1)), false)
  assert.equal(coalescesHeartbeat(execution, { activity: 'active', nextAction: 'tests' }, at(1)), false)
  assert.equal(coalescesHeartbeat(only(attached()), { activity: 'active' }, T0), false)
})

test('a handoff that ends the predecessor also ends its health and ignores later heartbeats', () => {
  const B = '00000000-0000-4000-8000-00000000000b'
  let meta = beat(attached(), { activity: 'active' })
  meta = appendEvent(meta, { type: 'session.attached', data: { execution: { ...execution, id: B } }, actor: 't' }, at(1)).meta
  meta = appendEvent(meta, { type: 'handoff', data: { fromExecutionId: A, toExecutionId: B, reason: 'context full', endPrevious: true }, actor: 't' }, at(2)).meta
  meta = beat(meta, { activity: 'blocked', blockReason: 'late', owner: 'x' }, at(3))
  const ended = only(meta)
  assert.ok(ended.endedAt)
  assert.equal(ended.heartbeat.activity, 'active')
  assert.equal(executionHealth(ended, at(4), { staleMs }).ended, true)
})
