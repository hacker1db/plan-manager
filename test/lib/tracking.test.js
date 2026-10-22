import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPlan, writePlan } from '../../dist/lib/metadata.js'
import { appendEvent, parsePrUrl, projectTracking, validateEvent, validateTracking, TRACKING_LIMITS } from '../../dist/lib/tracking.js'

const META = { id: 'plan-1', title: 'Plan', status: 'active', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', tags: [] }
const machine = installationId => ({ installationId, displayName: 'MacBookPro', hostname: 'MacBookPro', os: 'darwin', arch: 'arm64' })
const execution = (id, installationId) => ({
  id, provider: 'claude', nativeSessionId: null, role: 'implementation',
  machine: machine(installationId), environment: { id: installationId, type: 'host' },
})
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-tracking-test-'))
  process.env.PLAN_HOME = dir
  try { await fn(dir) } finally { await rm(dir, { recursive: true }) }
}

test('unknown frontmatter, tracking and format survive read/write round trips', async () => {
  await withHome(async dir => {
    for (const name of ['plan.md', 'plan.mdx']) {
      const fp = join(dir, name)
      const { meta } = appendEvent(META, { type: 'stage', data: { stage: 'in_progress' }, actor: 'tester' })
      await writePlan(fp, { ...meta, futureField: { nested: [1, 2] } }, 'Body')
      const first = await readPlan(fp)
      await writePlan(fp, { ...first.meta, status: first.meta.status }, first.body + '\n- [x] done')
      const second = await readPlan(fp)
      assert.deepEqual(second.meta.futureField, { nested: [1, 2] })
      assert.deepEqual(second.meta.tracking, meta.tracking)
      assert.equal(projectTracking(second.meta).stage, 'in_progress')
      if (name.endsWith('.mdx')) assert.equal(second.meta.format, 'mdx')
    }
  })
})

test('prototype keys are not copied and newer schemas refuse writes', async () => {
  await withHome(async dir => {
    const fp = join(dir, 'plan.md')
    await writeFile(fp, '---\nid: p\ntitle: P\nstatus: active\n__proto__: {polluted: true}\n---\nBody\n')
    const parsed = await readPlan(fp)
    assert.equal({}.polluted, undefined)
    assert.equal(Object.hasOwn(parsed.meta, '__proto__'), false)
    await writeFile(fp, '---\nid: p\ntitle: P\nstatus: active\nschemaVersion: 99\ntracking: {events: []}\n---\nBody\n')
    const before = await readFile(fp, 'utf8')
    await assert.rejects(writePlan(fp, (await readPlan(fp)).meta, 'changed'), { code: 'EUNSUPPORTEDSCHEMA' })
    assert.equal(await readFile(fp, 'utf8'), before)
  })
})

test('first event records migration provenance without inventing reviews', () => {
  const active = appendEvent(META, { type: 'session.attached', data: { execution: execution(A, A) }, actor: 'tester' }).meta
  assert.deepEqual(active.tracking.events.map(event => event.type), ['migrated', 'session.attached'])
  assert.equal(projectTracking(active).stage, 'planning')
  const completed = appendEvent({ ...META, status: 'completed' }, { type: 'session.attached', data: { execution: execution(A, A) }, actor: 'tester' }).meta
  assert.deepEqual(completed.tracking.events[0].data, { stage: 'completed', fromStatus: 'completed', legacyCompletion: true })
  assert.equal(projectTracking(completed).legacyCompletion, true)
  assert.equal(projectTracking(META).stage, 'planning')
})

test('idempotency keys deduplicate retries and reject different changes', () => {
  const input = { type: 'session.attached', data: { execution: execution(A, A) }, actor: 'tester', idempotencyKey: 'k' }
  const first = appendEvent(META, input)
  const retry = appendEvent(first.meta, input)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.meta.tracking.events.length, 2)
  assert.throws(() => appendEvent(first.meta, { ...input, data: { execution: execution(B, B) } }), { code: 'ECONFLICT' })
})

test('machines sharing a hostname stay distinct executions', () => {
  let meta = appendEvent(META, { type: 'session.attached', data: { execution: execution(A, A) }, actor: 't' }).meta
  meta = appendEvent(meta, { type: 'session.attached', data: { execution: execution(B, B) }, actor: 't' }).meta
  const installations = projectTracking(meta).executions.map(item => item.machine.installationId)
  assert.deepEqual(installations, [A, B])
})

test('completion keeps status in agreement and contradictions are refused', async () => {
  await withHome(async dir => {
    const fp = join(dir, 'plan.md')
    const { meta } = appendEvent(META, { type: 'completed', data: { reason: 'done', noPrRationale: 'docs only', coveredPrIds: [] }, actor: 't' })
    assert.equal(meta.status, 'completed')
    const reopened = appendEvent(meta, { type: 'reopened', data: { stage: 'in_progress', reason: 'more work' }, actor: 't' }).meta
    assert.equal(reopened.status, 'active')
    await assert.rejects(writePlan(fp, { ...reopened, status: 'completed' }, ''), { code: 'ESTAGECONFLICT' })
    await writePlan(fp, { ...reopened, status: 'archived' }, '')
  })
})

test('validation rejects unsupported fields, oversized events and malformed sequences', () => {
  const base = appendEvent(META, { type: 'stage', data: { stage: 'planning' }, actor: 't' }).meta.tracking.events[1]
  assert.throws(() => validateEvent({ ...base, data: { stage: 'planning', approvedBy: 'x' } }), /unsupported field/)
  assert.throws(() => validateEvent({ ...base, extra: true }), /unsupported field/)
  assert.throws(() => validateEvent({ ...base, data: { stage: 'planning', reason: 'x'.repeat(TRACKING_LIMITS.text + 1) } }), /at most/)
  assert.throws(() => validateEvent({ ...base, evidence: 'a\u0000b' }), /control characters/)
  assert.throws(() => validateTracking({ events: [base] }), /seq must be 1/)
  assert.throws(() => validateTracking({ events: Array.from({ length: TRACKING_LIMITS.events + 1 }, () => base) }), /more than/)
})

test('PR URLs are canonical github.com pull requests only', () => {
  assert.deepEqual(parsePrUrl('https://github.com/hacker1db/plan-manager/pull/9/'), { host: 'github.com', owner: 'hacker1db', repo: 'plan-manager', number: 9, url: 'https://github.com/hacker1db/plan-manager/pull/9' })
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://github.com/a/b/pull/1', 'https://u:p@github.com/a/b/pull/1',
    'https://github.com/a/b/pull/1?token=x', 'https://evil.example/a/b/pull/1', 'https://github.com.evil.example/a/b/pull/1', 'https://github.com/a/b/issues/1', 'https://github.com/../b/pull/1']) {
    assert.throws(() => parsePrUrl(bad), undefined, bad)
  }
})
