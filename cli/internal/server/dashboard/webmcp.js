// @ts-check
// WebMCP preview: exposes one read-only browser tool for the plan on screen.
//
// Shared by the local dashboard (Go server, cli/internal/server/dashboard) and the hosted
// app (static/webmcp.js). It is inert unless both gates are open:
//   1. the server marks the page with <html data-webmcp="preview"> (local: PLAN_WEBMCP_PREVIEW=1;
//      hosted: Vite dev only, never a production build), and
//   2. the viewer ticks the opt-in checkbox in the "Browser tools" panel (per tab).
// The API is the draft WebMCP Community Group spec (document.modelContext.registerTool with an
// AbortSignal); some early Chromium builds exposed navigator.modelContext instead, so both are
// feature-detected and nothing is assumed. The tool reads the existing same-origin, owner-only
// plan endpoint and returns an allowlist of fields; it never mutates and never lists the library.

export const TOOL_NAME = 'get-current-plan-summary'
export const OPT_IN_KEY = 'plan-manager:webmcp-opt-in'
export const SUMMARY_LIMIT = 280
export const STEP_LIMIT = 160
export const MAX_STEPS = 5

/**
 * @typedef {{
 *   readonly type: 'object' | 'array' | 'string' | 'integer',
 *   readonly description?: string,
 *   readonly enum?: readonly string[],
 *   readonly maxLength?: number,
 *   readonly maxItems?: number,
 *   readonly minimum?: number,
 *   readonly items?: JsonSchema,
 *   readonly properties?: Readonly<Record<string, JsonSchema>>,
 *   readonly required?: readonly string[],
 *   readonly additionalProperties?: false,
 * }} JsonSchema
 * @typedef {JsonSchema & { readonly type: 'object', readonly properties: Readonly<Record<string, JsonSchema>>, readonly additionalProperties: false }} ObjectSchema
 * @typedef {Readonly<Record<never, never>>} EmptyInput
 * @typedef {{ readOnlyHint?: boolean, untrustedContentHint?: boolean }} ToolAnnotations
 * @typedef {{ signal: AbortSignal }} ExecuteOptions
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   inputSchema: ObjectSchema,
 *   outputSchema: ObjectSchema,
 *   execute: (input: EmptyInput, options?: ExecuteOptions) => Promise<PlanSummary>,
 *   annotations: ToolAnnotations,
 * }} PlanTool
 * @typedef {{ registerTool: (tool: PlanTool, options: { signal: AbortSignal }) => Promise<void> | void }} ModelContext
 * @typedef {{ readonly modelContext: object | null }} ModelContextHost
 * @typedef {'local' | 'hosted'} Environment
 * @typedef {{
 *   id: string,
 *   title: string,
 *   status: string,
 *   updated: string,
 *   revision: string,
 *   source: { environment: Environment, path: string },
 *   summary: string,
 *   nextSteps: string[],
 *   openTaskCount: number,
 *   completedTaskCount: number,
 * }} PlanSummary
 * @typedef {{ id: string, title: string, status: string, updated: string, revision: string, markdown: string }} PlanRecord
 * @typedef {(path: string, init: RequestInit) => Promise<Response>} Fetcher
 */

/** @type {ObjectSchema} */
export const INPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }

/** @type {ObjectSchema} */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Plan ID.' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['active', 'completed', 'archived'] },
    updated: { type: 'string', description: 'ISO 8601 time of the last change.' },
    revision: { type: 'string', description: 'SHA-256 of the plan file; changes on every edit.' },
    source: {
      type: 'object',
      properties: {
        environment: { type: 'string', enum: ['local', 'hosted'] },
        path: { type: 'string', description: 'Dashboard path of this plan.' },
      },
      required: ['environment', 'path'],
      additionalProperties: false,
    },
    summary: { type: 'string', maxLength: SUMMARY_LIMIT, description: 'First prose paragraph of the plan, as plain text.' },
    nextSteps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'string', maxLength: STEP_LIMIT }, description: 'Open tasks, in document order.' },
    openTaskCount: { type: 'integer', minimum: 0 },
    completedTaskCount: { type: 'integer', minimum: 0 },
  },
  required: ['id', 'title', 'status', 'updated', 'revision', 'source', 'summary', 'nextSteps', 'openTaskCount', 'completedTaskCount'],
  additionalProperties: false,
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrows the untrusted API response to the fields the tool needs. The local server sends
 * `body`; the hosted API sends `markdown`. Everything else (file path, source path, comments,
 * HTML, tags) is dropped here.
 * @param {unknown} value
 * @returns {PlanRecord | null}
 */
export function parsePlanRecord(value) {
  if (!isRecord(value)) return null
  const { id, title, status, updated, revision } = value
  const markdown = typeof value.markdown === 'string' ? value.markdown : value.body
  if (typeof id !== 'string' || typeof title !== 'string' || typeof status !== 'string'
    || typeof updated !== 'string' || typeof revision !== 'string' || typeof markdown !== 'string') return null
  return { id, title, status, updated, revision, markdown }
}

/**
 * @param {string} text
 * @param {number} limit
 */
function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}

/** Reduces inline Markdown to plain text. @param {string} text */
function plain(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TASK = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/

/**
 * @param {string} markdown
 * @returns {{ summary: string, nextSteps: string[], openTaskCount: number, completedTaskCount: number }}
 */
export function summarizeMarkdown(markdown) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/<!--[\s\S]*?-->/g, '')
  /** @type {string[]} */
  const open = []
  let completedTaskCount = 0
  let summary = ''
  let fenced = false
  /** @type {string[]} */
  let paragraph = []
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const task = TASK.exec(line)
    if (task) {
      if (task[1] === ' ') open.push(clip(plain(task[2] ?? ''), STEP_LIMIT))
      else completedTaskCount += 1
    }
    if (summary) continue
    const prose = !task && !/^\s*(#|>|[-*+]\s|\d+[.)]\s|\||<|import\s|export\s)/.test(line)
    if (prose && line.trim()) paragraph.push(line)
    else if (paragraph.length) { summary = plain(paragraph.join(' ')); paragraph = [] }
  }
  if (!summary && paragraph.length) summary = plain(paragraph.join(' '))
  return {
    summary: clip(summary, SUMMARY_LIMIT),
    nextSteps: open.filter(Boolean).slice(0, MAX_STEPS),
    openTaskCount: open.length,
    completedTaskCount,
  }
}

/**
 * @param {PlanRecord} plan
 * @param {Environment} environment
 * @returns {PlanSummary}
 */
export function toPlanSummary(plan, environment) {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    updated: plan.updated,
    revision: plan.revision,
    source: { environment, path: `/plans/${encodeURIComponent(plan.id)}` },
    ...summarizeMarkdown(plan.markdown),
  }
}

/**
 * @param {unknown} value
 * @returns {value is ModelContext}
 */
function isModelContext(value) {
  return typeof value === 'object' && value !== null && 'registerTool' in value && typeof value.registerTool === 'function'
}

/**
 * Feature-detects a WebMCP registry: document.modelContext (draft spec, Chrome guide), then
 * navigator.modelContext (earlier explainer, Playwright docs). Returns null when neither exists.
 * @param {Document | ModelContextHost | null} doc
 * @param {Navigator | ModelContextHost | null} nav
 * @returns {ModelContext | null}
 */
export function detectModelContext(doc, nav) {
  for (const host of [doc, nav]) {
    if (!host || !('modelContext' in host)) continue
    const candidate = host.modelContext
    if (isModelContext(candidate)) return candidate
  }

  return null
}

export class ToolError extends Error {}

/**
 * Builds the read-only tool for one plan. The fetcher is the page's same-origin fetch, so the
 * existing session (WorkOS cookie or local dashboard session) authorizes every call.
 * @param {{ planId: string, environment: Environment, fetcher: Fetcher, onDenied: () => void }} options
 * @returns {PlanTool}
 */
export function createPlanTool({ planId, environment, fetcher, onDenied }) {
  return {
    name: TOOL_NAME,
    title: 'Current plan summary',
    description: 'Returns the title, status, revision, first paragraph, and open tasks of the plan open in this tab. Read-only.',
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    async execute(_input, options) {
      const response = await fetcher(`/api/plans/${encodeURIComponent(planId)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: options?.signal ?? null,
      })
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        onDenied()
        throw new ToolError('Plan unavailable; sign in again or reload the page.')
      }
      if (!response.ok) throw new ToolError(`Plan request failed with ${response.status}`)
      /** @type {unknown} */
      const value = await response.json()
      const plan = parsePlanRecord(value)
      if (!plan || plan.id !== planId) throw new ToolError('Unexpected plan response')
      return toPlanSummary(plan, environment)
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  }
}

/**
 * @param {Storage | null} storage
 * @returns {boolean}
 */
function readOptIn(storage) {
  try { return storage?.getItem(OPT_IN_KEY) === '1' } catch { return false }
}

/**
 * @param {Storage | null} storage
 * @param {boolean} value
 */
function writeOptIn(storage, value) {
  try {
    if (value) storage?.setItem(OPT_IN_KEY, '1')
    else storage?.removeItem(OPT_IN_KEY)
  } catch { /* storage blocked: opt-in lasts for this page only */ }
}

/** @returns {Storage | null} */
function sessionStore() {
  try { return window.sessionStorage } catch { return null }
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Mounts the disclosure and wires registration. Returns a cleanup that unregisters the tool.
 * @param {{ planId: string, environment: Environment, context: ModelContext | null, fetcher: Fetcher, mount: HTMLElement, storage: Storage | null }} options
 * @returns {() => void}
 */
export function mountBrowserTools({ planId, environment, context, fetcher, mount, storage }) {
  /** @type {AbortController | null} */
  let registration = null

  const panel = element('details', 'webmcp-panel')
  panel.id = 'webmcp-panel'
  const summary = element('summary', 'webmcp-summary')
  const label = element('span', 'webmcp-label', 'Browser tools')
  const state = element('span', 'webmcp-state')
  summary.append(label, state)

  const body = element('div', 'webmcp-body')
  const intro = element('p', 'webmcp-copy', 'Preview. Lets an AI agent in this browser read a summary of the plan on screen.')
  const toggleRow = element('label', 'webmcp-toggle')
  const toggle = element('input', '')
  toggle.type = 'checkbox'
  toggle.setAttribute('role', 'switch')
  toggle.setAttribute('aria-describedby', 'webmcp-exposes webmcp-status')
  toggleRow.append(toggle, element('span', '', 'Allow in this tab'))

  const exposes = element('div', 'webmcp-exposes')
  exposes.id = 'webmcp-exposes'
  exposes.append(element('p', 'webmcp-copy', `One read-only tool, ${TOOL_NAME}:`))
  const list = element('ul', 'webmcp-list')
  for (const item of ['Title, status, updated time, revision', 'First paragraph (≤280 characters)', `Up to ${MAX_STEPS} open tasks and task counts`]) {
    list.append(element('li', '', item))
  }
  exposes.append(list, element('p', 'webmcp-copy webmcp-faint', 'Never the full text, comments, file paths, other plans, or any write action.'))

  const status = element('p', 'webmcp-copy webmcp-status')
  status.id = 'webmcp-status'
  status.setAttribute('role', 'status')
  body.append(intro, toggleRow, exposes, status)
  panel.append(summary, body)

  /** @param {'off' | 'on' | 'pending' | 'unsupported' | 'signed-out' | 'error'} next @param {string} message */
  function show(next, message) {
    panel.dataset.state = next
    state.textContent = { off: 'Off', on: 'On', pending: 'Starting', unsupported: 'Unsupported', 'signed-out': 'Sign in', error: 'Error' }[next]
    status.textContent = message
  }

  function unregister() {
    registration?.abort()
    registration = null
  }

  function deny() {
    unregister()
    toggle.checked = false
    writeOptIn(storage, false)
    show('off', 'Turned off: this session can no longer read the plan.')
  }

  async function register() {
    if (!context) return
    unregister()
    const controller = new AbortController()
    registration = controller
    show('pending', 'Checking access…')
    try {
      // Registers only for a session that can already read this plan (owner/dashboard access).
      const probe = await fetcher(`/api/plans/${encodeURIComponent(planId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal })
      if (!probe.ok) {
        if (registration === controller) registration = null
        toggle.checked = false
        writeOptIn(storage, false)
        show('signed-out', 'Sign in to the dashboard first. Nothing is exposed.')
        return
      }
      await context.registerTool(createPlanTool({ planId, environment, fetcher, onDenied: deny }), { signal: controller.signal })
      if (registration === controller) show('on', `Agents in this browser can call ${TOOL_NAME}.`)
    } catch (failure) {
      if (registration === controller) registration = null
      toggle.checked = false
      show('error', failure instanceof Error ? `Could not register: ${failure.message}` : 'Could not register the tool.')
    }
  }

  if (!context) {
    toggle.disabled = true
    show('unsupported', 'This browser has no WebMCP support. Chromium 146+ with chrome://flags/#enable-webmcp-testing is required. Nothing is exposed.')
  } else {
    toggle.checked = readOptIn(storage)
    if (toggle.checked) void register()
    else show('off', 'Nothing is exposed until you allow it.')
    toggle.addEventListener('change', () => {
      writeOptIn(storage, toggle.checked)
      if (toggle.checked) void register()
      else { unregister(); show('off', 'Nothing is exposed until you allow it.') }
    })
  }

  mount.append(panel)
  return () => { unregister(); panel.remove() }
}

function start() {
  const root = document.documentElement
  if (root.dataset.webmcp !== 'preview') return
  if (!window.isSecureContext) return
  const planId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '')
  const rail = document.querySelector('.rail')
  if (!planId || !(rail instanceof HTMLElement)) return
  const mount = element('div', 'webmcp-mount')
  const foot = rail.querySelector('.rail-foot')
  if (foot) foot.before(mount)
  else rail.append(mount)
  const cleanup = mountBrowserTools({
    planId,
    environment: root.dataset.dashboardEnvironment === 'hosted' ? 'hosted' : 'local',
    context: detectModelContext(document, navigator),
    fetcher: (path, init) => window.fetch(path, init),
    mount,
    storage: sessionStore(),
  })
  // Unregister on navigation, sign-out (a navigation to /sign-out), and bfcache entry.
  window.addEventListener('pagehide', cleanup, { once: true })
}

if (typeof document !== 'undefined') start()
