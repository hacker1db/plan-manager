import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, projectTracking, validateEvent } from '../../dist/lib/tracking.js'

const META = { id: 'plan-1', title: 'Plan', status: 'active', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', tags: [] }
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const execution = id => ({
  id, provider: 'claude', nativeSessionId: null, role: 'implementation',
  machine: { installationId: id, displayName: 'Mac', hostname: 'Mac', os: 'darwin', arch: 'arm64' }, environment: { id, type: 'host' },
})
const apply = (meta, ...inputs) => inputs.reduce((current, [type, data]) => appendEvent(current, { type, data, actor: 't' }).meta, meta)
const attached = apply(META, ['session.attached', { execution: execution(A) }], ['session.attached', { execution: execution(B) }], ['session.attached', { execution: execution(C) }])

test('concurrent executions have no lead until one is designated', () => {
  assert.equal(projectTracking(attached).leadExecutionId, null)
  assert.equal(projectTracking(attached).executions.length, 3)
  assert.equal(projectTracking(apply(attached, ['session.lead', { executionId: B }])).leadExecutionId, B)
})

test('ending the lead leaves no lead; ending another session keeps it', () => {
  const led = apply(attached, ['session.lead', { executionId: A }])
  assert.equal(projectTracking(apply(led, ['session.ended', { executionId: B }])).leadExecutionId, A)
  assert.equal(projectTracking(apply(led, ['session.ended', { executionId: A }])).leadExecutionId, null, 'no silent promotion')
})

test('handoff moves the lead only from the lead and can end the predecessor', () => {
  const led = apply(attached, ['session.lead', { executionId: A }])
  const notLead = projectTracking(apply(led, ['handoff', { fromExecutionId: B, toExecutionId: C, reason: 'split' }]))
  assert.equal(notLead.leadExecutionId, A)
  const moved = projectTracking(apply(led,
    ['handoff', { fromExecutionId: A, toExecutionId: B, reason: 'context full', scope: 'phase 2', endPrevious: true }],
    ['handoff', { fromExecutionId: B, toExecutionId: C, reason: 'review' }]))
  assert.equal(moved.leadExecutionId, C)
  assert.deepEqual(moved.handoffs.map(item => [item.fromExecutionId, item.toExecutionId, item.reason, item.scope, item.actor]),
    [[A, B, 'context full', 'phase 2', 't'], [B, C, 'review', undefined, 't']])
  assert.notEqual(moved.executions.find(item => item.id === A).endedAt, undefined)
  assert.equal(moved.executions.find(item => item.id === B).endedAt, undefined)
})

test('handoff and lead data are validated', () => {
  const base = attached.tracking.events.at(-1)
  const handoff = data => validateEvent({ ...base, type: 'handoff', data })
  assert.throws(() => handoff({ fromExecutionId: A, toExecutionId: A, reason: 'x' }), /must differ/)
  assert.throws(() => handoff({ fromExecutionId: A, toExecutionId: B }), /data.reason/)
  assert.throws(() => handoff({ fromExecutionId: A, toExecutionId: B, reason: 'x', endPrevious: false }), /endPrevious/)
  assert.throws(() => handoff({ fromExecutionId: A, toExecutionId: B, reason: 'x', owner: 'y' }), /unsupported field/)
  assert.throws(() => validateEvent({ ...base, type: 'session.lead', data: { executionId: 'nope' } }), /UUID/)
})
