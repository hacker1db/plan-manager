import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendEvent, assertCompletion, assertPlanReview, assertReopen, assertStageTransition, bodyRevision, projectEvents, PLAN_STAGES,
} from '../../dist/lib/tracking.js'

const META = { id: 'plan-1', title: 'Plan', status: 'active', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', tags: [] }
const PR_ID = '00000000-0000-4000-8000-0000000000aa'
const pr = (overrides = {}) => ({
  id: PR_ID, host: 'github.com', owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', role: 'implements',
  attachedEventId: PR_ID, attachedAt: META.created, reviews: {},
  observed: { prId: PR_ID, state: 'merged', headSha: 'abc1234', observedAt: META.created },
  review: { state: 'approved', headSha: 'abc1234', reviewedAt: META.created, stale: false },
  ...overrides,
})
const projection = (stage, { approval = 'approved', stale = false, prs = [] } = {}) => ({
  stage, legacyCompletion: false, executions: [], prs, planApproval: { state: approval, bodyRevision: 'x', stale },
})

// Expected result of plan stage <target> from each stage, with a current approval and an open PR attached.
const MATRIX = {
  planning: { planning: 'noop', awaiting_plan_review: 'ok', in_progress: 'ok', awaiting_pr_review: 'deny', completed: 'deny' },
  awaiting_plan_review: { planning: 'ok', awaiting_plan_review: 'noop', in_progress: 'ok', awaiting_pr_review: 'deny', completed: 'deny' },
  in_progress: { planning: 'ok', awaiting_plan_review: 'deny', in_progress: 'noop', awaiting_pr_review: 'ok', completed: 'deny' },
  awaiting_pr_review: { planning: 'ok', awaiting_plan_review: 'deny', in_progress: 'ok', awaiting_pr_review: 'noop', completed: 'deny' },
  completed: { planning: 'deny', awaiting_plan_review: 'deny', in_progress: 'deny', awaiting_pr_review: 'deny', completed: 'deny' },
}

test('every stage transition is allowed or denied per the trigger table', () => {
  const open = [pr({ observed: { prId: PR_ID, state: 'open', headSha: 'abc1234', observedAt: META.created } })]
  for (const from of PLAN_STAGES) {
    for (const to of PLAN_STAGES) {
      const run = () => assertStageTransition(projection(from, { prs: open }), to)
      const expected = MATRIX[from][to]
      if (expected === 'deny') assert.throws(run, { code: 'ETRACKING' }, `${from} -> ${to}`)
      else assert.equal(run(), expected === 'ok', `${from} -> ${to}`)
    }
  }
})

test('starting work needs a current approval; PR review needs a non-draft open PR; resubmit needs a body change', () => {
  for (const options of [{ approval: 'none' }, { approval: 'pending' }, { approval: 'changes_requested' }, { stale: true }]) {
    assert.throws(() => assertStageTransition(projection('awaiting_plan_review', options), 'in_progress'), /approv/)
  }
  const draft = pr({ observed: { prId: PR_ID, state: 'draft', headSha: 'abc1234', observedAt: META.created } })
  assert.throws(() => assertStageTransition(projection('in_progress', { prs: [draft] }), 'awaiting_pr_review'), /draft/)
  assert.throws(() => assertStageTransition(projection('in_progress'), 'awaiting_pr_review'), /open for review/)
  assert.equal(assertStageTransition(projection('awaiting_plan_review', { approval: 'pending', stale: true }), 'awaiting_plan_review'), true)
})

test('plan reviews only apply to the submitted, unchanged body', () => {
  assertPlanReview(projection('awaiting_plan_review', { approval: 'pending' }))
  assert.throws(() => assertPlanReview(projection('planning')), /awaiting_plan_review/)
  assert.throws(() => assertPlanReview(projection('awaiting_plan_review', { approval: 'pending', stale: true })), /changed since/)
})

test('plan approval is keyed to the body revision and editing the body makes it stale', () => {
  const body = '# Plan\n- [ ] step\n'
  let meta = appendEvent(META, { type: 'stage', data: { stage: 'awaiting_plan_review', bodyRevision: bodyRevision(body) }, actor: 't' }).meta
  assert.deepEqual(projectEvents(meta.tracking.events, meta.status, body).planApproval, { state: 'pending', bodyRevision: bodyRevision(body), stale: false })
  meta = appendEvent(meta, { type: 'plan.review', data: { decision: 'approved', bodyRevision: bodyRevision(body) }, actor: 't' }).meta
  assert.equal(projectEvents(meta.tracking.events, meta.status, body).planApproval.state, 'approved')
  assert.equal(projectEvents(meta.tracking.events, meta.status, '\n' + body).planApproval.stale, false, 'frontmatter spacing is not a revision')
  assert.equal(projectEvents(meta.tracking.events, meta.status, body + 'more').planApproval.stale, true)
  const rejected = appendEvent(meta, { type: 'plan.review', data: { decision: 'changes_requested', bodyRevision: bodyRevision(body) }, actor: 't' }).meta
  assert.equal(projectEvents(rejected.tracking.events, rejected.status, body).stage, 'planning')
  assert.throws(() => appendEvent(meta, { type: 'plan.review', data: { decision: 'approved', bodyRevision: 'abc' }, actor: 't' }), /sha256/)
})

test('PR reviews are keyed to head SHA and go stale after a push; they never approve the plan', () => {
  const attached = { id: PR_ID, host: 'github.com', owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', role: 'implements' }
  let meta = appendEvent(META, { type: 'pr.attached', data: { pr: attached }, actor: 't' }).meta
  meta = appendEvent(meta, { type: 'pr.observed', data: { prId: PR_ID, state: 'open', headSha: 'abc1234' }, actor: 't' }).meta
  meta = appendEvent(meta, { type: 'pr.review', data: { prId: PR_ID, state: 'approved', headSha: 'abc1234' }, actor: 't' }).meta
  let projected = projectEvents(meta.tracking.events, meta.status)
  assert.equal(projected.prs[0].review.stale, false)
  assert.equal(projected.planApproval.state, 'none')
  meta = appendEvent(meta, { type: 'pr.observed', data: { prId: PR_ID, state: 'open', headSha: 'def5678' }, actor: 't' }).meta
  projected = projectEvents(meta.tracking.events, meta.status)
  assert.deepEqual([projected.prs[0].review.headSha, projected.prs[0].review.stale], ['abc1234', true])
  meta = appendEvent(meta, { type: 'pr.review', data: { prId: PR_ID, state: 'changes_requested', headSha: 'def5678' }, actor: 't' }).meta
  assert.deepEqual(projectEvents(meta.tracking.events, meta.status).prs[0].review.state, 'changes_requested')
  assert.throws(() => appendEvent(meta, { type: 'pr.review', data: { prId: PR_ID, state: 'lgtm', headSha: 'def5678' }, actor: 't' }), /data.state/)
  assert.throws(() => appendEvent(meta, { type: 'pr.review', data: { prId: PR_ID, state: 'approved' }, actor: 't' }), /headSha/)
})

test('completion requires approval and merged, approved implementing PRs or a no-PR rationale', () => {
  const observed = state => ({ prId: PR_ID, state, headSha: 'abc1234', observedAt: META.created })
  assert.deepEqual(assertCompletion(projection('in_progress', { prs: [pr()] })), [PR_ID])
  assert.deepEqual(assertCompletion(projection('awaiting_pr_review'), 'docs only'), [])
  const denied = [
    [projection('planning', { prs: [pr()] }), undefined, /Cannot complete/],
    [projection('in_progress', { prs: [pr()], stale: true }), undefined, /approval/],
    [projection('in_progress', { prs: [pr()], approval: 'pending' }), undefined, /approved plan review/],
    [projection('in_progress'), undefined, /no-pr-rationale/],
    [projection('in_progress', { prs: [pr()] }), 'docs only', /only for plans without/],
    [projection('in_progress', { prs: [pr({ role: 'partial' })] }), undefined, /Only partial/],
    [projection('in_progress', { prs: [pr({ observed: observed('draft') })] }), undefined, /draft, not merged/],
    [projection('in_progress', { prs: [pr({ observed: observed('closed') })] }), undefined, /closed, not merged/],
    [projection('in_progress', { prs: [pr({ observed: undefined })] }), undefined, /not observed/],
    [projection('in_progress', { prs: [pr({ review: undefined })] }), undefined, /approved review/],
    [projection('in_progress', { prs: [pr({ review: { state: 'approved', headSha: 'old0000', reviewedAt: META.created, stale: true } })] }), undefined, /approved review/],
    [projection('in_progress', { prs: [pr({ review: { state: 'dismissed', headSha: 'abc1234', reviewedAt: META.created, stale: false } })] }), undefined, /approved review/],
  ]
  for (const [state, rationale, message] of denied) assert.throws(() => assertCompletion(state, rationale), message)
})

test('reopen only leaves completed, keeps history, and in_progress needs a current approval', () => {
  assertReopen(projection('completed', { approval: 'none' }), 'planning')
  assertReopen(projection('completed'), 'in_progress')
  assert.throws(() => assertReopen(projection('completed', { stale: true }), 'in_progress'), /approval/)
  assert.throws(() => assertReopen(projection('in_progress'), 'planning'), /Only completed/)
  let meta = appendEvent(META, { type: 'completed', data: { reason: 'done', noPrRationale: 'docs', coveredPrIds: [] }, actor: 't' }).meta
  assert.equal(meta.status, 'completed')
  meta = appendEvent(meta, { type: 'reopened', data: { stage: 'planning', reason: 'missed a step' }, actor: 't' }).meta
  assert.equal(meta.status, 'active')
  assert.deepEqual(meta.tracking.events.map(event => event.type), ['migrated', 'completed', 'reopened'])
  assert.throws(() => appendEvent(meta, { type: 'reopened', data: { stage: 'completed', reason: 'x' }, actor: 't' }), /data.stage/)
  assert.throws(() => appendEvent(meta, { type: 'completed', data: { coveredPrIds: [] }, actor: 't' }), /data.reason/)
})
