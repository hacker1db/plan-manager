import {
  assertCompletion, assertPlanReview, assertReopen, assertStageTransition, bodyRevision, coalescesHeartbeat, parsePrUrl, prKey, projectTracking,
  PLAN_REVIEW_DECISIONS, PLAN_STAGES, PR_REVIEW_STATES, REOPEN_STAGES, TrackingError,
  type EventInput, type EventSource, type PlanReviewDecision, type PlanStage, type PrReviewState, type ReopenStage,
} from './tracking.js'
import type { PlanMetadata, UnknownRecord } from './types.js'

// Guarded tracking changes shared by the CLI and the local server, so both enforce exactly the same rules.
export interface ActionParams {
  actor: string
  source?: EventSource
  idempotencyKey?: string
  evidence?: string
  reason?: string
  stage?: string
  executionId?: string
  fromExecutionId?: string
  toExecutionId?: string
  scope?: string
  endPrevious?: boolean
  decision?: string
  pr?: string
  state?: string
  head?: string
  noPrRationale?: string
  activity?: string
  owner?: string
  nextAction?: string
  observedAt?: string
}
export type ActionMutation = { input: EventInput } | { result: UnknownRecord }
type Action = (meta: PlanMetadata, body: string, params: ActionParams) => ActionMutation

export const ACTION_PARAM_FIELDS = ['actor', 'idempotencyKey', 'evidence', 'reason', 'stage', 'executionId', 'fromExecutionId', 'toExecutionId', 'scope', 'endPrevious', 'decision', 'pr', 'state', 'head', 'noPrRationale', 'activity', 'owner', 'nextAction', 'observedAt'] as const

function need(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TrackingError(`${name} is required`)
  return value
}

function oneOf<T extends string>(value: string | undefined, name: string, values: readonly T[]): T {
  if (!(values as readonly string[]).includes(value ?? '')) throw new TrackingError(`${name} must be one of: ${values.join(', ')}`)
  return value as T
}

function input(params: ActionParams, type: EventInput['type'], data: UnknownRecord, extra: Partial<EventInput> = {}): ActionMutation {
  return { input: { type, data, actor: params.actor, source: params.source, idempotencyKey: params.idempotencyKey, evidence: params.evidence, ...extra } }
}

export function findExecution(meta: PlanMetadata, executionId: string) {
  const execution = projectTracking(meta).executions.find(item => item.id === executionId)
  if (!execution) throw Object.assign(new Error(`No session ${executionId} on plan ${meta.id}`), { code: 'ENOTFOUND' })
  return execution
}

export function liveExecution(meta: PlanMetadata, executionId: string) {
  const execution = findExecution(meta, executionId)
  if (execution.endedAt) throw new TrackingError(`Session ${executionId} has ended and cannot lead`)
  return execution
}

export function findPr(meta: PlanMetadata, reference: string) {
  let key: string | undefined
  try { key = prKey(parsePrUrl(reference)) } catch { key = undefined }
  const pr = projectTracking(meta).prs.find(item => item.id === reference || prKey(item) === key)
  if (!pr) throw Object.assign(new Error(`No attached PR ${reference} on plan ${meta.id}`), { code: 'ENOTFOUND' })
  return pr
}

export const TRACKING_ACTIONS: Record<string, Action> = {
  stage(meta, body, p) {
    const target = oneOf(p.stage, 'stage', PLAN_STAGES) as PlanStage
    if (!assertStageTransition(projectTracking(meta, body), target)) return { result: {} }
    // Submitting pins the exact body revision under review.
    return input(p, 'stage', { stage: target, ...(p.reason ? { reason: p.reason } : {}), ...(target === 'awaiting_plan_review' ? { bodyRevision: bodyRevision(body) } : {}) })
  },
  'review-plan'(meta, body, p) {
    const decision = oneOf(p.decision, 'decision', PLAN_REVIEW_DECISIONS) as PlanReviewDecision
    assertPlanReview(projectTracking(meta, body))
    return input(p, 'plan.review', { decision, bodyRevision: bodyRevision(body) })
  },
  'review-pr'(meta, _body, p) {
    const state = oneOf(p.state, 'state', PR_REVIEW_STATES) as PrReviewState
    const head = need(p.head, 'head').toLowerCase()
    const pr = findPr(meta, need(p.pr, 'pr'))
    return input(p, 'pr.review', { prId: pr.id, state, headSha: head })
  },
  complete(meta, body, p) {
    const reason = need(p.reason, 'reason')
    const coveredPrIds = assertCompletion(projectTracking(meta, body), p.noPrRationale)
    return input(p, 'completed', { reason, ...(p.noPrRationale ? { noPrRationale: p.noPrRationale } : {}), coveredPrIds })
  },
  reopen(meta, body, p) {
    const target = oneOf(p.stage, 'stage', REOPEN_STAGES) as ReopenStage
    const reason = need(p.reason, 'reason')
    assertReopen(projectTracking(meta, body), target)
    return input(p, 'reopened', { stage: target, reason })
  },
  'session-end'(meta, _body, p) {
    const executionId = need(p.executionId, 'executionId')
    if (findExecution(meta, executionId).endedAt) return { result: { executionId } }
    return input(p, 'session.ended', { executionId })
  },
  'session-lead'(meta, _body, p) {
    const executionId = need(p.executionId, 'executionId')
    liveExecution(meta, executionId)
    if (projectTracking(meta).leadExecutionId === executionId) return { result: { executionId } }
    return input(p, 'session.lead', { executionId })
  },
  handoff(meta, _body, p) {
    const from = need(p.fromExecutionId, 'fromExecutionId')
    const to = need(p.toExecutionId, 'toExecutionId')
    const reason = need(p.reason, 'reason')
    findExecution(meta, from)
    liveExecution(meta, to)
    return input(p, 'handoff', { fromExecutionId: from, toExecutionId: to, reason, ...(p.scope ? { scope: p.scope } : {}), ...(p.endPrevious === true ? { endPrevious: true } : {}) })
  },
  heartbeat(meta, _body, p) {
    const executionId = need(p.executionId, 'executionId')
    const data: UnknownRecord = { executionId, activity: p.activity ?? 'active', blockReason: p.reason, owner: p.owner, nextAction: p.nextAction }
    const execution = findExecution(meta, executionId)
    if (execution.endedAt) throw new TrackingError(`Session ${executionId} has ended; heartbeats are rejected`)
    if (coalescesHeartbeat(execution, data, new Date())) return { result: { coalesced: true } }
    return input(p, 'session.heartbeat', data, { observedAt: p.observedAt })
  },
  'pr-detach'(meta, _body, p) {
    const pr = findPr(meta, need(p.pr, 'pr'))
    return input(p, 'pr.detached', { prId: pr.id }, { revokes: pr.attachedEventId })
  },
}
