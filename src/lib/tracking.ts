import { randomUUID } from 'node:crypto'
import { isPlanStatus, type PlanMetadata, type PlanStatus, type UnknownRecord } from './types.js'

export const TRACKING_SCHEMA_VERSION = 1
export const PLAN_STAGES = ['planning', 'awaiting_plan_review', 'in_progress', 'awaiting_pr_review', 'completed'] as const
export const PROVIDERS = ['t3-code', 'claude', 'codex', 'other'] as const
export const EXECUTION_ROLES = ['planning', 'implementation', 'review'] as const
export const ENVIRONMENT_TYPES = ['host', 'vm', 'container', 'remote'] as const
export const PR_ROLES = ['implements', 'partial', 'followup', 'supporting'] as const
export const PR_STATES = ['open', 'draft', 'closed', 'merged'] as const
export const EVENT_TYPES = ['migrated', 'stage', 'session.attached', 'session.ended', 'pr.attached', 'pr.detached', 'pr.observed'] as const
export const EVENT_SOURCES = ['cli', 'server', 'migration'] as const
export const TRACKING_LIMITS = { events: 500, eventBytes: 4096, text: 512 }

export type PlanStage = typeof PLAN_STAGES[number]
export type Provider = typeof PROVIDERS[number]
export type ExecutionRole = typeof EXECUTION_ROLES[number]
export type EnvironmentType = typeof ENVIRONMENT_TYPES[number]
export type PrRole = typeof PR_ROLES[number]
export type PrState = typeof PR_STATES[number]
export type EventType = typeof EVENT_TYPES[number]
export type EventSource = typeof EVENT_SOURCES[number]

export interface MachineIdentity { installationId: string; displayName: string; hostname: string; os: string; arch: string }
export interface EnvironmentIdentity { id: string; type: EnvironmentType; parentId?: string }
export interface Execution {
  id: string
  provider: Provider
  // null means the provider gave no verified native ID; it is never guessed.
  nativeSessionId: string | null
  providerNamespace?: string
  role: ExecutionRole
  machine: MachineIdentity
  environment: EnvironmentIdentity
  repository?: string
  worktree?: string
  branch?: string
  commit?: string
}
export interface PrAssociation { id: string; host: string; owner: string; repo: string; number: number; url: string; role: PrRole }
export interface PrObservation { prId: string; state: PrState; headSha?: string; mergeSha?: string }

export interface TrackingEvent {
  id: string
  seq: number
  type: EventType
  schemaVersion: number
  actor: string
  source: EventSource
  recordedAt: string
  observedAt?: string
  idempotencyKey?: string
  evidence?: string
  revokes?: string
  data: UnknownRecord
}
export interface Tracking { events: TrackingEvent[] }

export interface ProjectedExecution extends Execution { attachedEventId: string; startedAt: string; endedAt?: string }
export interface ProjectedPr extends PrAssociation { attachedEventId: string; attachedAt: string; observed?: PrObservation & { observedAt: string } }
export interface TrackingProjection {
  stage: PlanStage
  // True when completion predates tracking, so its review gates are unknown rather than satisfied.
  legacyCompletion: boolean
  executions: ProjectedExecution[]
  prs: ProjectedPr[]
}

export class TrackingError extends Error {
  code: string
  constructor(message: string, code = 'ETRACKING') { super(message); this.code = code }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{7,64}$/

function fail(message: string): never { throw new TrackingError(message) }

function record(value: unknown, field: string, allowed: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field} has unsupported field "${key}"`)
  return value as UnknownRecord
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TRACKING_LIMITS.text) fail(`${field} must be a non-empty string of at most ${TRACKING_LIMITS.text} characters`)
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${field} contains control characters`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) fail(`${field} must be one of: ${values.join(', ')}`)
  return value as T
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a UUID`)
  return value
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp`)
  return value
}

function sha(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SHA.test(value)) fail(`${field} must be a hex commit SHA`)
  return value
}

function clean<T extends UnknownRecord>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export function validateMachine(value: unknown, field = 'machine'): MachineIdentity {
  const raw = record(value, field, ['installationId', 'displayName', 'hostname', 'os', 'arch'])
  return {
    installationId: uuid(raw.installationId, `${field}.installationId`),
    displayName: text(raw.displayName, `${field}.displayName`),
    hostname: text(raw.hostname, `${field}.hostname`),
    os: text(raw.os, `${field}.os`),
    arch: text(raw.arch, `${field}.arch`),
  }
}

export function validateEnvironment(value: unknown, field = 'environment'): EnvironmentIdentity {
  const raw = record(value, field, ['id', 'type', 'parentId'])
  return clean({
    id: uuid(raw.id, `${field}.id`),
    type: oneOf(raw.type, `${field}.type`, ENVIRONMENT_TYPES),
    parentId: raw.parentId === undefined ? undefined : uuid(raw.parentId, `${field}.parentId`),
  })
}

export function validateExecution(value: unknown, field = 'execution'): Execution {
  const raw = record(value, field, ['id', 'provider', 'nativeSessionId', 'providerNamespace', 'role', 'machine', 'environment', 'repository', 'worktree', 'branch', 'commit'])
  return clean({
    id: uuid(raw.id, `${field}.id`),
    provider: oneOf(raw.provider, `${field}.provider`, PROVIDERS),
    nativeSessionId: raw.nativeSessionId === null || raw.nativeSessionId === undefined ? null : text(raw.nativeSessionId, `${field}.nativeSessionId`),
    providerNamespace: optionalText(raw.providerNamespace, `${field}.providerNamespace`),
    role: oneOf(raw.role, `${field}.role`, EXECUTION_ROLES),
    machine: validateMachine(raw.machine, `${field}.machine`),
    environment: validateEnvironment(raw.environment, `${field}.environment`),
    repository: optionalText(raw.repository, `${field}.repository`),
    worktree: optionalText(raw.worktree, `${field}.worktree`),
    branch: optionalText(raw.branch, `${field}.branch`),
    commit: sha(raw.commit, `${field}.commit`),
  })
}

const GITHUB_PR_PATH = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})\/?$/

// shortcut: only github.com is accepted; add an allowlist entry when a GitHub Enterprise host is needed.
export function parsePrUrl(value: string): Omit<PrAssociation, 'id' | 'role'> {
  let url: URL
  try { url = new URL(value) } catch { fail(`Not a URL: ${value}`) }
  if (url.protocol !== 'https:') fail('PR URL must use https')
  if (url.username || url.password) fail('PR URL must not contain credentials')
  if (url.search || url.hash) fail('PR URL must not contain a query or fragment')
  if (url.hostname !== 'github.com' || url.port) fail('PR URL host must be github.com')
  const match = GITHUB_PR_PATH.exec(url.pathname)
  if (!match) fail('PR URL must look like https://github.com/<owner>/<repo>/pull/<number>')
  const [, owner, repo, number] = match
  return { host: 'github.com', owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/pull/${number}` }
}

export function prKey(pr: Pick<PrAssociation, 'host' | 'owner' | 'repo' | 'number'>): string {
  return `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()
}

function validatePr(value: unknown, field = 'pr'): PrAssociation {
  const raw = record(value, field, ['id', 'host', 'owner', 'repo', 'number', 'url', 'role'])
  const parsed = parsePrUrl(text(raw.url, `${field}.url`))
  if (raw.host !== parsed.host || raw.owner !== parsed.owner || raw.repo !== parsed.repo || raw.number !== parsed.number || raw.url !== parsed.url) fail(`${field} identity does not match its canonical URL`)
  return { id: uuid(raw.id, `${field}.id`), ...parsed, role: oneOf(raw.role, `${field}.role`, PR_ROLES) }
}

function validateData(type: EventType, value: unknown): UnknownRecord {
  switch (type) {
    case 'migrated': {
      const raw = record(value, 'data', ['stage', 'fromStatus', 'legacyCompletion'])
      if (!isPlanStatus(raw.fromStatus)) fail('data.fromStatus must be a plan status')
      if (typeof raw.legacyCompletion !== 'boolean') fail('data.legacyCompletion must be a boolean')
      return { stage: oneOf(raw.stage, 'data.stage', PLAN_STAGES), fromStatus: raw.fromStatus, legacyCompletion: raw.legacyCompletion }
    }
    case 'stage': {
      const raw = record(value, 'data', ['stage', 'reason'])
      return clean({ stage: oneOf(raw.stage, 'data.stage', PLAN_STAGES), reason: optionalText(raw.reason, 'data.reason') })
    }
    case 'session.attached': return { execution: validateExecution(record(value, 'data', ['execution']).execution) }
    case 'session.ended': return { executionId: uuid(record(value, 'data', ['executionId']).executionId, 'data.executionId') }
    case 'pr.attached': return { pr: validatePr(record(value, 'data', ['pr']).pr) }
    case 'pr.detached': return { prId: uuid(record(value, 'data', ['prId']).prId, 'data.prId') }
    case 'pr.observed': {
      const raw = record(value, 'data', ['prId', 'state', 'headSha', 'mergeSha'])
      return clean({ prId: uuid(raw.prId, 'data.prId'), state: oneOf(raw.state, 'data.state', PR_STATES), headSha: sha(raw.headSha, 'data.headSha'), mergeSha: sha(raw.mergeSha, 'data.mergeSha') })
    }
  }
}

export function validateEvent(value: unknown, field = 'event'): TrackingEvent {
  const raw = record(value, field, ['id', 'seq', 'type', 'schemaVersion', 'actor', 'source', 'recordedAt', 'observedAt', 'idempotencyKey', 'evidence', 'revokes', 'data'])
  if (raw.schemaVersion !== TRACKING_SCHEMA_VERSION) fail(`${field}.schemaVersion ${String(raw.schemaVersion)} is not supported`)
  if (!Number.isInteger(raw.seq) || (raw.seq as number) < 1) fail(`${field}.seq must be a positive integer`)
  const type = oneOf(raw.type, `${field}.type`, EVENT_TYPES)
  const event = clean({
    id: uuid(raw.id, `${field}.id`),
    seq: raw.seq as number,
    type,
    schemaVersion: TRACKING_SCHEMA_VERSION,
    actor: text(raw.actor, `${field}.actor`),
    source: oneOf(raw.source, `${field}.source`, EVENT_SOURCES),
    recordedAt: timestamp(raw.recordedAt, `${field}.recordedAt`),
    observedAt: raw.observedAt === undefined ? undefined : timestamp(raw.observedAt, `${field}.observedAt`),
    idempotencyKey: optionalText(raw.idempotencyKey, `${field}.idempotencyKey`),
    evidence: optionalText(raw.evidence, `${field}.evidence`),
    revokes: raw.revokes === undefined ? undefined : uuid(raw.revokes, `${field}.revokes`),
    data: validateData(type, raw.data),
  }) as TrackingEvent
  if (JSON.stringify(event).length > TRACKING_LIMITS.eventBytes) fail(`${field} exceeds ${TRACKING_LIMITS.eventBytes} bytes`)
  return event
}

export function validateTracking(value: unknown): Tracking {
  const raw = record(value, 'tracking', ['events'])
  if (!Array.isArray(raw.events)) fail('tracking.events must be an array')
  if (raw.events.length > TRACKING_LIMITS.events) fail(`tracking has more than ${TRACKING_LIMITS.events} events`)
  const ids = new Set<string>()
  const keys = new Set<string>()
  const events = raw.events.map((item, index) => {
    const event = validateEvent(item, `tracking.events[${index}]`)
    if (event.seq !== index + 1) fail(`tracking.events[${index}].seq must be ${index + 1}`)
    if (ids.has(event.id)) fail(`tracking.events[${index}].id is duplicated`)
    if (event.idempotencyKey !== undefined && keys.has(event.idempotencyKey)) fail(`tracking.events[${index}].idempotencyKey is duplicated`)
    ids.add(event.id)
    if (event.idempotencyKey !== undefined) keys.add(event.idempotencyKey)
    return event
  })
  return { events }
}

export function readTracking(meta: PlanMetadata): Tracking | undefined {
  if (meta.schemaVersion !== undefined && meta.schemaVersion > TRACKING_SCHEMA_VERSION) {
    throw new TrackingError(`Plan ${meta.id} uses tracking schema ${meta.schemaVersion}; upgrade plan to edit it`, 'EUNSUPPORTEDSCHEMA')
  }
  return meta.tracking === undefined ? undefined : validateTracking(meta.tracking)
}

function legacyStage(status: PlanStatus): { stage: PlanStage; legacyCompletion: boolean } {
  return status === 'completed' ? { stage: 'completed', legacyCompletion: true } : { stage: 'planning', legacyCompletion: false }
}

export function projectEvents(events: TrackingEvent[], status: PlanStatus): TrackingProjection {
  const projection: TrackingProjection = { ...legacyStage(status), executions: [], prs: [] }
  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'migrated':
        projection.stage = data.stage as PlanStage
        projection.legacyCompletion = data.legacyCompletion as boolean
        break
      case 'stage':
        projection.stage = data.stage as PlanStage
        projection.legacyCompletion = false
        break
      case 'session.attached':
        projection.executions.push({ ...data.execution as Execution, attachedEventId: event.id, startedAt: event.observedAt ?? event.recordedAt })
        break
      case 'session.ended': {
        const execution = projection.executions.find(item => item.id === data.executionId)
        if (execution) execution.endedAt = event.observedAt ?? event.recordedAt
        break
      }
      case 'pr.attached':
        projection.prs.push({ ...data.pr as PrAssociation, attachedEventId: event.id, attachedAt: event.recordedAt })
        break
      case 'pr.detached':
        projection.prs = projection.prs.filter(item => item.id !== data.prId)
        break
      case 'pr.observed': {
        const pr = projection.prs.find(item => item.id === data.prId)
        if (pr) pr.observed = { ...data as unknown as PrObservation, observedAt: event.observedAt ?? event.recordedAt }
        break
      }
    }
  }
  return projection
}

export function projectTracking(meta: PlanMetadata): TrackingProjection {
  return projectEvents(readTracking(meta)?.events ?? [], meta.status)
}

// Stage is null when tracking cannot be read, so callers show it as unknown instead of guessing.
export function safeStage(meta: PlanMetadata): PlanStage | null {
  try { return projectTracking(meta).stage } catch { return null }
}

// Archived is a storage disposition, so only active/completed must agree with the stage.
export function assertStageMatchesStatus(meta: PlanMetadata): void {
  if (meta.tracking === undefined || meta.status === 'archived') return
  let stage: PlanStage
  try { stage = projectTracking(meta).stage } catch { return }
  if ((stage === 'completed') !== (meta.status === 'completed')) {
    throw new TrackingError(`Status "${meta.status}" contradicts tracked stage "${stage}"; change it with plan stage`, 'ESTAGECONFLICT')
  }
}

export interface EventInput {
  type: EventType
  data: UnknownRecord
  actor: string
  source?: EventSource
  observedAt?: string
  idempotencyKey?: string
  evidence?: string
  revokes?: string
}

function sameEvent(event: TrackingEvent, input: EventInput): boolean {
  return event.type === input.type && JSON.stringify(event.data) === JSON.stringify(validateData(input.type, input.data))
}

export function appendEvent(meta: PlanMetadata, input: EventInput, now = new Date()): { meta: PlanMetadata; event: TrackingEvent; duplicate: boolean } {
  const existing = readTracking(meta)
  if (input.idempotencyKey !== undefined) {
    const prior = existing?.events.find(event => event.idempotencyKey === input.idempotencyKey)
    if (prior) {
      if (!sameEvent(prior, input)) throw new TrackingError(`Idempotency key "${input.idempotencyKey}" was already used for a different change`, 'ECONFLICT')
      return { meta, event: prior, duplicate: true }
    }
  }
  const recordedAt = now.toISOString()
  const events = existing ? [...existing.events] : []
  if (events.length === 0) {
    events.push(validateEvent({
      id: randomUUID(), seq: 1, type: 'migrated', schemaVersion: TRACKING_SCHEMA_VERSION, actor: input.actor, source: 'migration', recordedAt,
      data: { ...legacyStage(meta.status), fromStatus: meta.status },
    }))
  }
  const event = validateEvent(clean({
    id: randomUUID(),
    seq: events.length + 1,
    schemaVersion: TRACKING_SCHEMA_VERSION,
    source: input.source ?? 'cli',
    recordedAt,
    type: input.type,
    data: input.data,
    actor: input.actor,
    observedAt: input.observedAt,
    idempotencyKey: input.idempotencyKey,
    evidence: input.evidence,
    revokes: input.revokes,
  }))
  events.push(event)
  const tracking = validateTracking({ events })
  const stage = projectEvents(tracking.events, meta.status).stage
  const status: PlanStatus = meta.status === 'archived' ? 'archived' : stage === 'completed' ? 'completed' : 'active'
  return { meta: { ...meta, status, schemaVersion: TRACKING_SCHEMA_VERSION, tracking }, event, duplicate: false }
}
