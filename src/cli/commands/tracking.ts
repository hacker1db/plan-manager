import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { initStorage, resolveByIdOrSlug, containedPath } from '../../lib/storage.js'
import { readPlan, writePlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { assertRevision } from '../../lib/revisions.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { localMachine } from '../../lib/machine.js'
import {
  appendEvent, coalescesHeartbeat, parsePrUrl, prKey, projectTracking, validateEnvironment, PLAN_STAGES, PR_ROLES,
  assertCompletion, assertPlanReview, assertReopen, assertStageTransition, bodyRevision, PLAN_REVIEW_DECISIONS, PR_REVIEW_STATES, REOPEN_STAGES,
  TrackingError, type EnvironmentIdentity, type EventInput, type PlanStage, type PrObservation, type PrRole, type TrackingEvent,
  type PlanReviewDecision, type PrReviewState, type ReopenStage,
} from '../../lib/tracking.js'
import type { CliOptions, PlanEnvelope, PlanMetadata, UnknownRecord } from '../../lib/types.js'
import { EXIT } from '../exit.js'

type Mutation = { input: EventInput } | { result: UnknownRecord }
interface Outcome { envelope: PlanEnvelope; event?: TrackingEvent; duplicate: boolean; result?: UnknownRecord }

const ERROR_EXITS: Record<string, number> = {
  EAMBIGUOUS: EXIT.AMBIGUOUS, ENOTFOUND: EXIT.NOT_FOUND, ECONFLICT: EXIT.CONFLICT, ELOCKTIMEOUT: EXIT.CONFLICT,
  EPATHTRAVERSAL: EXIT.PATH_TRAVERSAL, ETRACKING: EXIT.INVALID_INPUT, ESTAGECONFLICT: EXIT.INVALID_INPUT,
  EUNSUPPORTEDSCHEMA: EXIT.INVALID_INPUT, EMETADATALIMIT: EXIT.INVALID_INPUT, EDEPENDENCY: EXIT.DEPENDENCY_UNAVAILABLE,
}

function usage(message: string): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(EXIT.INVALID_INPUT)
}

function exitFor(err: unknown): never {
  const error = err as Error & { code?: string; currentRevision?: string; suppliedRevision?: string }
  const code = error.code !== undefined ? ERROR_EXITS[error.code] : undefined
  if (code === undefined) throw err
  if (error.code === 'ECONFLICT' && error.currentRevision) {
    process.stderr.write(JSON.stringify({ error: 'conflict', currentRevision: error.currentRevision, suppliedRevision: error.suppliedRevision }) + '\n')
  } else {
    process.stderr.write(`Error: ${error.message}\n`)
  }
  process.exit(code)
}

function actor(opts: CliOptions): string {
  return opts.actor || userInfo().username
}

// Retried calls with the same key must produce the same entity ID so the retry is recognized as a duplicate.
function entityId(planId: string, key: string | undefined): string {
  if (key === undefined) return randomUUID()
  const hex = createHash('sha256').update(`${planId}\0${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function loadPlan(idOrSlug: string) {
  const resolved = await resolveByIdOrSlug(idOrSlug)
  if (!containedPath(resolved.filePath)) throw Object.assign(new Error('Path not contained in plan home'), { code: 'EPATHTRAVERSAL' })
  return readPlan(resolved.filePath)
}

async function mutate(idOrSlug: string, opts: CliOptions, build: (meta: PlanMetadata, body: string) => Mutation): Promise<Outcome> {
  await initStorage()
  return withPlanWriteLock(async () => {
    const parsed = await loadPlan(idOrSlug)
    if (opts.ifRevision) await assertRevision(parsed.filePath, opts.ifRevision)
    const mutation = build(parsed.meta, parsed.body)
    if ('result' in mutation) return { envelope: await buildEnvelope(parsed), duplicate: true, result: mutation.result }
    const { meta, event, duplicate } = appendEvent(parsed.meta, mutation.input)
    if (!duplicate) await writePlan(parsed.filePath, meta, parsed.body)
    return { envelope: await buildEnvelope(duplicate ? parsed : await readPlan(parsed.filePath)), event, duplicate }
  })
}

function report(opts: CliOptions, outcome: Outcome, extra: UnknownRecord, summary: string): void {
  const result = { ...outcome.envelope, ...extra, ...(outcome.event ? { event: outcome.event } : {}), duplicate: outcome.duplicate, ...outcome.result }
  process.stdout.write(opts.json ? JSON.stringify(result) + '\n' : `${outcome.duplicate ? 'Unchanged' : summary}\n  revision: ${outcome.envelope.revision}\n`)
}

async function readJsonInput(opts: CliOptions): Promise<UnknownRecord> {
  let raw: string
  if (opts.stdin) {
    raw = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) raw += chunk
  } else if (opts.file) {
    raw = await readFile(opts.file, 'utf8').catch((err: Error) => usage(`reading file: ${err.message}`))
  } else {
    usage('session details are required as JSON via --stdin or --file')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { usage('session details must be valid JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) usage('session details must be a JSON object')
  return value as UnknownRecord
}

const SESSION_INPUT_FIELDS = ['provider', 'nativeSessionId', 'providerNamespace', 'role', 'repository', 'worktree', 'branch', 'commit', 'environment', 'observedAt', 'idempotencyKey', 'evidence']

function environmentFor(value: unknown, host: EnvironmentIdentity): EnvironmentIdentity {
  if (value === undefined) return host
  const raw = value as UnknownRecord
  if (raw?.type === 'host' && raw.id === undefined) return host
  // A VM/container/remote environment is a different executor from its controller, so it needs its own ID.
  return validateEnvironment({ ...raw, ...(raw?.type !== 'host' && raw?.parentId === undefined ? { parentId: host.id } : {}) })
}

async function sessionAttach(idOrSlug: string, opts: CliOptions): Promise<void> {
  const input = await readJsonInput(opts)
  for (const key of Object.keys(input)) if (!SESSION_INPUT_FIELDS.includes(key)) usage(`unsupported session field "${key}"`)
  const { machine, host } = await localMachine()
  const idempotencyKey = opts.idempotencyKey ?? input.idempotencyKey as string | undefined
  const outcome = await mutate(idOrSlug, opts, meta => {
    const execution = {
      id: entityId(meta.id, idempotencyKey),
      provider: input.provider,
      nativeSessionId: input.nativeSessionId ?? null,
      providerNamespace: input.providerNamespace,
      role: opts.role ?? input.role ?? 'implementation',
      machine,
      environment: environmentFor(input.environment, host),
      repository: input.repository,
      worktree: input.worktree,
      branch: input.branch,
      commit: input.commit,
    }
    return { input: { type: 'session.attached', data: { execution }, actor: actor(opts), observedAt: input.observedAt as string | undefined, idempotencyKey, evidence: opts.evidence ?? input.evidence as string | undefined } }
  })
  const executionId = (outcome.event?.data.execution as { id: string }).id
  report(opts, outcome, { executionId }, `Attached session ${executionId}`)
}

async function sessionEnd(idOrSlug: string, executionId: string | undefined, opts: CliOptions): Promise<void> {
  if (!executionId) usage('execution ID required\n  Usage: plan session end <id-or-slug> <execution-id>')
  const outcome = await mutate(idOrSlug, opts, meta => {
    const execution = projectTracking(meta).executions.find(item => item.id === executionId)
    if (!execution) throw Object.assign(new Error(`No session ${executionId} on plan ${meta.id}`), { code: 'ENOTFOUND' })
    if (execution.endedAt) return { result: { executionId } }
    return { input: { type: 'session.ended', data: { executionId }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, { executionId }, `Ended session ${executionId}`)
}

function liveExecution(meta: PlanMetadata, executionId: string) {
  const execution = projectTracking(meta).executions.find(item => item.id === executionId)
  if (!execution) throw Object.assign(new Error(`No session ${executionId} on plan ${meta.id}`), { code: 'ENOTFOUND' })
  if (execution.endedAt) throw new TrackingError(`Session ${executionId} has ended and cannot lead`)
  return execution
}

async function sessionLead(idOrSlug: string, executionId: string | undefined, opts: CliOptions): Promise<void> {
  if (!executionId) usage('execution ID required\n  Usage: plan session lead <id-or-slug> <execution-id>')
  const outcome = await mutate(idOrSlug, opts, meta => {
    liveExecution(meta, executionId)
    if (projectTracking(meta).leadExecutionId === executionId) return { result: { executionId } }
    return { input: { type: 'session.lead', data: { executionId }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, { executionId, leadExecutionId: executionId }, `Lead session ${executionId}`)
}

async function handoff(idOrSlug: string, from: string | undefined, to: string | undefined, opts: CliOptions): Promise<void> {
  const help = '\n  Usage: plan handoff <id-or-slug> <from-execution-id> <to-execution-id> --reason <text> [--scope <text>] [--end-previous]'
  if (!from || !to) usage(`predecessor and successor execution IDs required${help}`)
  if (!opts.reason) usage(`--reason is required${help}`)
  let leadExecutionId: string | null = null
  const outcome = await mutate(idOrSlug, opts, meta => {
    const projection = projectTracking(meta)
    if (!projection.executions.some(item => item.id === from)) throw Object.assign(new Error(`No session ${from} on plan ${meta.id}`), { code: 'ENOTFOUND' })
    liveExecution(meta, to)
    leadExecutionId = projection.leadExecutionId === from ? to : projection.leadExecutionId
    const data = { fromExecutionId: from, toExecutionId: to, reason: opts.reason, ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.endPrevious ? { endPrevious: true } : {}) }
    return { input: { type: 'handoff', data, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, { fromExecutionId: from, toExecutionId: to, leadExecutionId }, `Handed off ${from} to ${to}`)
}

interface GhPr { url: string; state: string; isDraft: boolean; headRefOid?: string; mergeCommit?: { oid?: string } | null }

// External PR data is untrusted: only identity and state facts are read from it, and identity must match what was asked for.
function fetchPr(url: string): { url: string; observation: Omit<PrObservation, 'prId'> } {
  const result = spawnSync(process.env.PLAN_GH ?? 'gh', ['pr', 'view', url, '--json', 'url,state,isDraft,headRefOid,mergeCommit'], { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw new TrackingError(`gh is required to verify pull requests: ${result.error.message}`, 'EDEPENDENCY')
  if (result.status !== 0) throw new TrackingError(`gh could not read ${url}: ${result.stderr.trim()}`, 'EDEPENDENCY')
  let pr: GhPr
  try { pr = JSON.parse(result.stdout) as GhPr } catch { throw new TrackingError('gh returned malformed JSON', 'EDEPENDENCY') }
  const canonical = parsePrUrl(String(pr.url))
  if (prKey(canonical) !== prKey(parsePrUrl(url))) throw new TrackingError(`gh resolved ${url} to a different pull request (${canonical.url})`)
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : null
  if (state === null) throw new TrackingError(`gh reported unknown PR state "${pr.state}"`, 'EDEPENDENCY')
  return { url: canonical.url, observation: { state, headSha: pr.headRefOid?.toLowerCase(), mergeSha: pr.mergeCommit?.oid?.toLowerCase() } }
}

function findPr(meta: PlanMetadata, reference: string) {
  const prs = projectTracking(meta).prs
  let key: string | undefined
  try { key = prKey(parsePrUrl(reference)) } catch { key = undefined }
  const pr = prs.find(item => item.id === reference || prKey(item) === key)
  if (!pr) throw Object.assign(new Error(`No attached PR ${reference} on plan ${meta.id}`), { code: 'ENOTFOUND' })
  return pr
}

async function prAttach(idOrSlug: string, url: string | undefined, opts: CliOptions): Promise<void> {
  if (!url) usage('PR URL required\n  Usage: plan pr attach <id-or-slug> <pr-url> [--role implements|partial|followup|supporting]')
  const role = (opts.role ?? 'implements') as PrRole
  if (!PR_ROLES.includes(role)) usage(`invalid role "${role}" (valid: ${PR_ROLES.join(', ')})`)
  let fetched: ReturnType<typeof fetchPr>
  try { parsePrUrl(url); fetched = fetchPr(url) } catch (err) { exitFor(err) }
  const identity = parsePrUrl(fetched.url)
  // The PR attach and its first observation are two events, so the observation is appended in a second locked write.
  const outcome = await mutate(idOrSlug, opts, meta => {
    const existing = projectTracking(meta).prs.find(item => prKey(item) === prKey(identity))
    if (existing) return { result: { prId: existing.id } }
    const pr = { id: entityId(meta.id, opts.idempotencyKey), ...identity, role }
    return { input: { type: 'pr.attached', data: { pr }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  const prId = (outcome.event?.data.pr as { id: string } | undefined)?.id ?? outcome.result?.prId as string
  const observed = outcome.duplicate ? outcome : await observe(idOrSlug, prId, fetched.observation, opts)
  report(opts, { ...outcome, envelope: observed.envelope }, { prId, url: identity.url }, `Attached ${identity.url}`)
}

async function observe(idOrSlug: string, prId: string, observation: Omit<PrObservation, 'prId'>, opts: CliOptions): Promise<Outcome> {
  return mutate(idOrSlug, { ...opts, ifRevision: undefined }, meta => {
    const current = findPr(meta, prId).observed
    // Unchanged observations are skipped so refreshes do not grow the plan file.
    if (current && current.state === observation.state && current.headSha === observation.headSha && current.mergeSha === observation.mergeSha) return { result: { prId } }
    return { input: { type: 'pr.observed', data: { prId, ...observation }, actor: actor(opts), source: 'cli', observedAt: new Date().toISOString(), evidence: 'gh pr view' } }
  })
}

async function prDetach(idOrSlug: string, reference: string | undefined, opts: CliOptions): Promise<void> {
  if (!reference) usage('PR URL or ID required\n  Usage: plan pr detach <id-or-slug> <pr-url|pr-id>')
  const outcome = await mutate(idOrSlug, opts, meta => {
    const pr = findPr(meta, reference)
    return { input: { type: 'pr.detached', data: { prId: pr.id }, revokes: pr.attachedEventId, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, {}, `Detached ${reference}`)
}

async function prRefresh(idOrSlug: string, reference: string | undefined, opts: CliOptions): Promise<void> {
  // Fetch outside the write lock: gh calls are slow and must not block other plan writers.
  await initStorage()
  const parsed = await loadPlan(idOrSlug)
  const targets = reference ? [findPr(parsed.meta, reference)] : projectTracking(parsed.meta).prs
  const refreshed = []
  let outcome: Outcome = { envelope: await buildEnvelope(parsed), duplicate: true }
  for (const pr of targets) {
    const { observation } = fetchPr(pr.url)
    const next = await observe(idOrSlug, pr.id, observation, opts)
    refreshed.push({ prId: pr.id, url: pr.url, ...observation, changed: !next.duplicate })
    outcome = { envelope: next.envelope, duplicate: outcome.duplicate && next.duplicate }
  }
  report(opts, outcome, { prs: refreshed }, `Refreshed ${refreshed.length} PR${refreshed.length === 1 ? '' : 's'}`)
}

async function stage(idOrSlug: string, target: string | undefined, opts: CliOptions): Promise<void> {
  if (!target || !(PLAN_STAGES as readonly string[]).includes(target)) usage(`stage required (valid: ${PLAN_STAGES.join(', ')})\n  Usage: plan stage <id-or-slug> <stage> [--reason <text>]`)
  const outcome = await mutate(idOrSlug, opts, (meta, body) => {
    if (!assertStageTransition(projectTracking(meta, body), target as PlanStage)) return { result: {} }
    // Submitting pins the exact body revision under review.
    const data = { stage: target, ...(opts.reason ? { reason: opts.reason } : {}), ...(target === 'awaiting_plan_review' ? { bodyRevision: bodyRevision(body) } : {}) }
    return { input: { type: 'stage', data, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, {}, `Stage: ${target}`)
}

async function reviewPlan(idOrSlug: string, opts: CliOptions): Promise<void> {
  const decision = opts.decision as PlanReviewDecision
  if (!PLAN_REVIEW_DECISIONS.includes(decision)) usage(`--decision required (valid: ${PLAN_REVIEW_DECISIONS.join(', ')})`)
  const outcome = await mutate(idOrSlug, opts, (meta, body) => {
    assertPlanReview(projectTracking(meta, body))
    return { input: { type: 'plan.review', data: { decision, bodyRevision: bodyRevision(body) }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, {}, `Plan review: ${decision}`)
}

async function reviewPr(idOrSlug: string, reference: string | undefined, opts: CliOptions): Promise<void> {
  if (!reference) usage('PR URL or ID required\n  Usage: plan review record <id-or-slug> pr <pr-url|pr-id> --state <state> --head <sha>')
  const state = opts.state as PrReviewState
  if (!PR_REVIEW_STATES.includes(state)) usage(`--state required (valid: ${PR_REVIEW_STATES.join(', ')})`)
  if (!opts.head) usage('--head <sha> required: a review applies to one PR head commit')
  const outcome = await mutate(idOrSlug, opts, meta => {
    const pr = findPr(meta, reference)
    return { input: { type: 'pr.review', data: { prId: pr.id, state, headSha: opts.head!.toLowerCase() }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  const prId = outcome.event?.data.prId as string
  report(opts, outcome, { prId }, `PR review: ${state}`)
}

async function complete(idOrSlug: string, opts: CliOptions): Promise<void> {
  if (!opts.reason) usage('--reason required\n  Usage: plan complete <id-or-slug> --reason <text> [--no-pr-rationale <text>]')
  const outcome = await mutate(idOrSlug, opts, (meta, body) => {
    const coveredPrIds = assertCompletion(projectTracking(meta, body), opts.noPrRationale)
    const data = { reason: opts.reason, ...(opts.noPrRationale ? { noPrRationale: opts.noPrRationale } : {}), coveredPrIds }
    return { input: { type: 'completed', data, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, {}, 'Completed')
}

async function reopen(idOrSlug: string, opts: CliOptions): Promise<void> {
  const target = opts.stage as ReopenStage
  if (!REOPEN_STAGES.includes(target) || !opts.reason) usage(`--stage and --reason required\n  Usage: plan reopen <id-or-slug> --stage ${REOPEN_STAGES.join('|')} --reason <text>`)
  const outcome = await mutate(idOrSlug, opts, (meta, body) => {
    assertReopen(projectTracking(meta, body), target)
    return { input: { type: 'reopened', data: { stage: target, reason: opts.reason }, actor: actor(opts), idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, {}, `Reopened: ${target}`)
}

async function sessionHeartbeat(idOrSlug: string, executionId: string | undefined, opts: CliOptions): Promise<void> {
  if (!executionId) usage('execution ID required\n  Usage: plan session heartbeat <id-or-slug> <execution-id> [--activity active|idle|blocked]')
  const data: UnknownRecord = { executionId, activity: opts.activity ?? 'active', blockReason: opts.reason, owner: opts.owner, nextAction: opts.next }
  const outcome = await mutate(idOrSlug, opts, meta => {
    const execution = projectTracking(meta).executions.find(item => item.id === executionId)
    if (!execution) throw Object.assign(new Error(`No session ${executionId} on plan ${meta.id}`), { code: 'ENOTFOUND' })
    if (execution.endedAt) throw new TrackingError(`Session ${executionId} has ended; heartbeats are rejected`)
    if (coalescesHeartbeat(execution, data, new Date())) return { result: { coalesced: true } }
    return { input: { type: 'session.heartbeat', data, actor: actor(opts), observedAt: opts.observedAt, idempotencyKey: opts.idempotencyKey, evidence: opts.evidence } }
  })
  report(opts, outcome, { executionId, coalesced: false }, `Heartbeat ${data.activity} for ${executionId}`)
}

export async function cmdSession(args: string[], opts: CliOptions): Promise<void> {
  const [sub, idOrSlug, executionId] = args
  if (!idOrSlug) usage('Usage: plan session <attach|end|lead|heartbeat> <id-or-slug> ...')
  try {
    if (sub === 'attach') return await sessionAttach(idOrSlug, opts)
    if (sub === 'end') return await sessionEnd(idOrSlug, executionId, opts)
    if (sub === 'lead') return await sessionLead(idOrSlug, executionId, opts)
    if (sub === 'heartbeat') return await sessionHeartbeat(idOrSlug, executionId, opts)
  } catch (err) { exitFor(err) }
  usage(`Unknown session subcommand: ${sub}\n  Usage: plan session <attach|end|lead|heartbeat> <id-or-slug> ...`)
}

export async function cmdHandoff(args: string[], opts: CliOptions): Promise<void> {
  const [idOrSlug, from, to] = args
  if (!idOrSlug) usage('Usage: plan handoff <id-or-slug> <from-execution-id> <to-execution-id> --reason <text>')
  try { await handoff(idOrSlug, from, to, opts) } catch (err) { exitFor(err) }
}

export async function cmdPr(args: string[], opts: CliOptions): Promise<void> {
  const [sub, idOrSlug, reference] = args
  if (!idOrSlug) usage('Usage: plan pr <attach|detach|refresh> <id-or-slug> ...')
  try {
    if (sub === 'attach') return await prAttach(idOrSlug, reference, opts)
    if (sub === 'detach') return await prDetach(idOrSlug, reference, opts)
    if (sub === 'refresh') return await prRefresh(idOrSlug, reference, opts)
  } catch (err) { exitFor(err) }
  usage(`Unknown pr subcommand: ${sub}\n  Usage: plan pr <attach|detach|refresh> <id-or-slug> ...`)
}

export async function cmdStage(args: string[], opts: CliOptions): Promise<void> {
  const [idOrSlug, target] = args
  if (!idOrSlug) usage(`Usage: plan stage <id-or-slug> <${PLAN_STAGES.join('|')}>`)
  try { await stage(idOrSlug, target, opts) } catch (err) { exitFor(err) }
}

export async function cmdReview(args: string[], opts: CliOptions): Promise<void> {
  const [sub, idOrSlug, kind, reference] = args
  const help = '  Usage: plan review record <id-or-slug> plan --decision approved|changes_requested\n         plan review record <id-or-slug> pr <pr-url|pr-id> --state <state> --head <sha>'
  if (sub !== 'record' || !idOrSlug) usage(`Usage: plan review record <id-or-slug> <plan|pr> ...\n${help}`)
  try {
    if (kind === 'plan') return await reviewPlan(idOrSlug, opts)
    if (kind === 'pr') return await reviewPr(idOrSlug, reference, opts)
  } catch (err) { exitFor(err) }
  usage(`review target must be plan or pr\n${help}`)
}

export async function cmdComplete(args: string[], opts: CliOptions): Promise<void> {
  if (!args[0]) usage('Usage: plan complete <id-or-slug> --reason <text> [--no-pr-rationale <text>]')
  try { await complete(args[0], opts) } catch (err) { exitFor(err) }
}

export async function cmdReopen(args: string[], opts: CliOptions): Promise<void> {
  if (!args[0]) usage(`Usage: plan reopen <id-or-slug> --stage ${REOPEN_STAGES.join('|')} --reason <text>`)
  try { await reopen(args[0], opts) } catch (err) { exitFor(err) }
}
