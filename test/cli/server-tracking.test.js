import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { startServer } from '../../dist/server/server.js'

const cleanup = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())) })

const PLAN = `---
id: tracked_plan
title: Tracked
status: active
created: '2026-07-25T00:00:00.000Z'
updated: '2026-07-25T00:00:00.000Z'
tags: []
---
# Body
`

async function running() {
  const planHome = await mkdtemp(join(tmpdir(), 'plan-server-tracking-'))
  await writeFile(join(planHome, 'tracked.md'), PLAN)
  const server = await startServer({ planHome, port: 0, watch: false })
  cleanup.push(() => server.close(), () => rm(planHome, { recursive: true, force: true }))
  const base = `http://127.0.0.1:${server.port}`
  const { csrfToken } = await (await fetch(`${base}/_session`)).json()
  const post = async (action, body, headers = { 'x-csrf-token': csrfToken }) => {
    const response = await fetch(`${base}/api/plans/tracked_plan/tracking/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return { planHome, post, base, csrfToken }
}

test('tracking actions go through the same guards as the CLI', async () => {
  const { post } = await running()
  const denied = await post('stage', { stage: 'in_progress' })
  assert.equal(denied.status, 400)
  assert.match(denied.body.error, /approved plan review/)

  const submitted = await post('stage', { stage: 'awaiting_plan_review', idempotencyKey: 'submit-1' })
  assert.equal(submitted.status, 200)
  assert.equal(submitted.body.tracking.stage, 'awaiting_plan_review')
  assert.equal(submitted.body.event.source, 'server')
  assert.equal((await post('stage', { stage: 'awaiting_plan_review', idempotencyKey: 'submit-1' })).body.duplicate, true)

  const approved = await post('review-plan', { decision: 'approved', revision: submitted.body.revision })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.tracking.planApproval.state, 'approved')
  assert.equal((await post('stage', { stage: 'in_progress', revision: submitted.body.revision })).status, 409, 'stale revision is refused')
  assert.equal((await post('stage', { stage: 'in_progress' })).body.tracking.stage, 'in_progress')
  assert.equal((await post('complete', { reason: 'x' })).status, 400, 'completion still needs PR evidence or a rationale')
})

test('tracking requests are authorized and strictly validated', async () => {
  const { post, planHome } = await running()
  const before = await readFile(join(planHome, 'tracked.md'), 'utf8')
  assert.equal((await post('stage', { stage: 'awaiting_plan_review' }, {})).status, 403, 'missing csrf token')
  assert.equal((await post('stage', { stage: 'awaiting_plan_review' }, { 'x-csrf-token': 'nope' })).status, 403)
  assert.equal((await post('stage', { stage: 'awaiting_plan_review', source: 'migration' })).status, 400, 'source cannot be forged')
  assert.equal((await post('stage', { stage: 'awaiting_plan_review', endPrevious: 'yes' })).status, 400)
  assert.equal((await post('constructor', {})).status, 404)
  assert.equal((await post('session-end', { executionId: '00000000-0000-4000-8000-000000000001' })).status, 404)
  assert.equal(await readFile(join(planHome, 'tracked.md'), 'utf8'), before, 'refused requests write nothing')
})

test('dashboard status changes cannot contradict the tracked stage', async () => {
  const { post, planHome, base, csrfToken } = await running()
  await post('stage', { stage: 'awaiting_plan_review' })
  const before = await readFile(join(planHome, 'tracked.md'), 'utf8')
  const response = await fetch(`${base}/api/plans/tracked_plan/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ status: 'completed' }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /contradicts tracked stage/)
  assert.equal(await readFile(join(planHome, 'tracked.md'), 'utf8'), before)
})
