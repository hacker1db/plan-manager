// @ts-nocheck
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { watch } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'

import { getHost, getPlanHome, getPort } from '../lib/config.js'
import { computeRevision } from '../lib/ids.js'
import { parseFrontmatter } from '../lib/metadata.js'
import { formatFromPath, isPlanFilename } from '../lib/mdx/format.js'
import { renderMdxToHtml } from '../lib/mdx/html.js'
import { withPlanWriteLock } from '../lib/write-lock.js'

const STATUS_VALUES = new Set(['active', 'completed', 'archived'])
const ALLOWED_HOSTNAMES = new Set(['plans.localhost', '127.0.0.1', 'localhost'])
const MAX_BODY_BYTES = 64 * 1024
const STABILITY_DELAY_MS = 120
const WATCH_DEBOUNCE_MS = 300
const RECONCILE_INTERVAL_MS = 5000

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(value))
}

function error(res, status, message) {
  json(res, status, { error: message })
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', chunk => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        const bodyError = new Error('request body too large')
        bodyError.code = 'ETOOLARGE'
        reject(bodyError)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sanitizeRenderedHtml(value) {
  return value
    .replace(/<input\b[^>]*\/?>/gi, input => {
      const attributes = input
        .replace(/^<input\s*/i, '')
        .replace(/\/?\s*>$/, '')
      const allowed = /^type\s*=\s*(?:"checkbox"|'checkbox'|checkbox)(?:\s+checked(?:\s*=\s*(?:""|''|checked))?)?\s*$/i
      if (!allowed.test(attributes)) return ''
      return `<input type="checkbox" data-plan-task="true"${/\bchecked\b/i.test(attributes) ? ' checked' : ''}>`
    })
    .replace(/<(script|style|iframe|object|embed|form|button|meta|base)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|button|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"']*\2/gi, ' $1="#"')
}

async function renderMarkdown(markdown) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pandoc', [
      // -raw_html alone leaves pandoc's raw_attribute extension on, so a
      // `...`{=html} span or fenced block still emits arbitrary HTML that
      // sanitizeRenderedHtml below does not catch. Disable both.
      '--from=markdown-raw_html-raw_attribute',
      '--to=html5',
      '--no-highlight',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let outputSize = 0
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const renderError = new Error('Pandoc rendering timed out')
      renderError.code = 'ETIMEDOUT'
      reject(renderError)
    }, 10000)
    child.stdout.on('data', chunk => {
      outputSize += chunk.length
      if (outputSize > 4 * 1024 * 1024) {
        child.kill('SIGKILL')
        const renderError = new Error('Pandoc output too large')
        renderError.code = 'ETOOLARGE'
        reject(renderError)
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', childError => {
      clearTimeout(timer)
      reject(childError)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `Pandoc exited with ${code}`))
        return
      }
      resolvePromise(sanitizeRenderedHtml(Buffer.concat(stdout).toString('utf8')))
    })
    child.stdin.end(markdown)
  })
}

function updateTaskMarker(body, index, checked) {
  const marker = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/gm
  let currentIndex = -1
  let updated = false
  const nextBody = body.replace(marker, (match, prefix) => {
    currentIndex += 1
    if (currentIndex !== index) return match
    updated = true
    return `${prefix}[${checked ? 'x' : ' '}]`
  })
  return updated ? nextBody : null
}

async function ensureDirectory(pathname) {
  try {
    const info = await lstat(pathname)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      const directoryError = new Error(`Path exists but is not a directory: ${pathname}`)
      directoryError.code = 'ENOTDIR'
      throw directoryError
    }
  } catch (directoryError) {
    if (directoryError.code !== 'ENOENT') throw directoryError
    await mkdir(pathname, { recursive: true })
  }
}

function isContained(root, candidate) {
  const normalizedRoot = normalize(resolve(root))
  const normalizedCandidate = normalize(resolve(candidate))
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function validMetadata(meta) {
  return meta !== null &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    typeof meta.id === 'string' &&
    /^[A-Za-z0-9_-]{4,128}$/.test(meta.id) &&
    typeof meta.title === 'string' &&
    meta.title.trim().length > 0 &&
    STATUS_VALUES.has(meta.status) &&
    typeof meta.created === 'string' &&
    typeof meta.updated === 'string' &&
    Array.isArray(meta.tags) &&
    meta.tags.every(tag => typeof tag === 'string')
}

export async function startServer(options = {}) {
  const planHome = resolve(options.planHome ?? getPlanHome())
  const archiveHome = join(planHome, 'archive')
  const requestedPort = options.port ?? getPort()
  const host = options.host ?? getHost()
  const watchEnabled = options.watch !== false
  const stabilityDelay = options.stabilityDelayMs ?? STABILITY_DELAY_MS
  const watchDebounce = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS
  const reconcileInterval = options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS

  if (host !== '127.0.0.1') {
    const hostError = new Error('Plan server must bind to 127.0.0.1')
    hostError.code = 'EHOSTUNSAFE'
    throw hostError
  }

  await ensureDirectory(planHome)
  await ensureDirectory(archiveHome)

  async function planFiles() {
    const files = []
    for (const directory of [planHome, archiveHome]) {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !isPlanFilename(entry.name)) continue
        const filePath = join(directory, entry.name)
        if (isContained(planHome, filePath)) files.push(filePath)
      }
    }
    return files.sort()
  }

  async function readStrictPlan(filePath) {
    if (!isContained(planHome, filePath)) {
      const pathError = new Error('path traversal rejected')
      pathError.code = 'EPATH'
      throw pathError
    }
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      const pathError = new Error('plan is not a regular file')
      pathError.code = 'EPATH'
      throw pathError
    }
    const raw = await readFile(filePath, 'utf8')
    const parsed = parseFrontmatter(raw)
    if (!validMetadata(parsed.meta)) {
      const metadataError = new Error(`Malformed plan metadata: ${basename(filePath)}`)
      metadataError.code = 'EMALFORMED'
      throw metadataError
    }
    return {
      meta: parsed.meta,
      format: parsed.meta.format === 'mdx' || formatFromPath(filePath) === 'mdx' ? 'mdx' : 'md',
      body: parsed.body,
      raw,
      filePath,
      revision: await computeRevision(raw),
      isArchived: dirname(filePath) === archiveHome,
    }
  }

  async function indexPlans() {
    const plans = []
    const malformed = []
    for (const filePath of await planFiles()) {
      try {
        plans.push(await readStrictPlan(filePath))
      } catch (planError) {
        malformed.push({ file: basename(filePath), error: planError.message })
      }
    }
    return { plans, malformed }
  }

  async function findPlan(id) {
    const matches = []
    const { plans } = await indexPlans()
    for (const plan of plans) {
      if (plan.meta.id === id) matches.push(plan)
    }
    if (matches.length > 1) {
      const duplicateError = new Error(`Duplicate plan ID: ${id}`)
      duplicateError.code = 'EDUPLICATE'
      throw duplicateError
    }
    return matches[0] ?? null
  }

  async function atomicPlanWrite(filePath, meta, body) {
    if (!isContained(planHome, filePath)) {
      const pathError = new Error('path traversal rejected')
      pathError.code = 'EPATH'
      throw pathError
    }
    const updatedMeta = { ...meta, updated: new Date().toISOString() }
    if (formatFromPath(filePath) === 'mdx') updatedMeta.format = 'mdx'
    const frontmatter = yaml.dump(updatedMeta, { lineWidth: -1 }).trimEnd()
    const content = `---\n${frontmatter}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`
    const temporaryPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    )
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await rename(temporaryPath, filePath)
    } catch (writeError) {
      await unlink(temporaryPath).catch(() => {})
      throw writeError
    }
    return readStrictPlan(filePath)
  }

  async function captureSnapshot() {
    const records = []
    for (const filePath of await planFiles()) {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      const revision = await computeRevision(raw)
      const parsed = parseFrontmatter(raw)
      const id = validMetadata(parsed.meta) ? parsed.meta.id : null
      records.push({
        path: filePath.slice(planHome.length + 1),
        revision,
        id,
      })
    }
    const fingerprint = createHash('sha256')
      .update(records.map(record => `${record.path}:${record.revision}`).join('\n'))
      .digest('hex')
    return { fingerprint, records }
  }

  const csrfToken = randomBytes(32).toString('hex')
  const clients = new Set()
  let currentSnapshot = await captureSnapshot()
  let sequence = 0
  let closed = false
  let actualPort = requestedPort
  let debounceTimer = null
  let scanPromise = null
  let fileWatcher = null
  let heartbeatTimer = null
  let reconcileTimer = null
  let pandocAvailable = null

  async function pandocIsAvailable() {
    if (pandocAvailable !== null) return pandocAvailable
    pandocAvailable = await new Promise(resolvePromise => {
      const child = spawn('pandoc', ['--version'], { stdio: 'ignore' })
      child.once('error', () => resolvePromise(false))
      child.once('close', code => resolvePromise(code === 0))
    })
    return pandocAvailable
  }

  function event(type, value) {
    sequence += 1
    const wire = `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({
      sequence,
      ...value,
    })}\n\n`
    for (const client of clients) {
      try {
        client.write(wire)
      } catch {
        clients.delete(client)
      }
    }
  }

  function planRevisionMap(snapshot) {
    const revisions = new Map()
    for (const record of snapshot.records) {
      if (record.id) revisions.set(record.id, record.revision)
    }
    return revisions
  }

  async function stableScan() {
    if (closed) return
    if (scanPromise) return scanPromise
    scanPromise = (async () => {
      const first = await captureSnapshot()
      await sleep(stabilityDelay)
      const second = await captureSnapshot()
      if (first.fingerprint !== second.fingerprint) {
        scheduleScan()
        return
      }
      if (second.fingerprint === currentSnapshot.fingerprint) return
      const previousRevisions = planRevisionMap(currentSnapshot)
      const currentRevisions = planRevisionMap(second)
      const changed = []
      const removed = []
      for (const [id, revision] of currentRevisions) {
        if (previousRevisions.get(id) !== revision) changed.push({ id, revision })
      }
      for (const id of previousRevisions.keys()) {
        if (!currentRevisions.has(id)) removed.push(id)
      }
      currentSnapshot = second
      event('library', {
        fingerprint: second.fingerprint,
        changed,
        removed,
      })
      for (const plan of changed) {
        event('plan', plan)
      }
    })().finally(() => {
      scanPromise = null
    })
    return scanPromise
  }

  function scheduleScan() {
    if (closed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      stableScan().catch(() => {})
    }, watchDebounce)
  }

  function expectedAuthority() {
    return new Set([
      `plans.localhost:${actualPort}`,
      `127.0.0.1:${actualPort}`,
      `localhost:${actualPort}`,
    ])
  }

  function requestIsSameOrigin(req, res) {
    const hostHeader = (req.headers.host ?? '').toLowerCase()
    if (!expectedAuthority().has(hostHeader)) {
      error(res, 421, 'unexpected host')
      return false
    }
    const originHeader = req.headers.origin
    if (!originHeader) return true
    try {
      const origin = new URL(originHeader)
      if (
        origin.protocol !== 'http:' ||
        !ALLOWED_HOSTNAMES.has(origin.hostname) ||
        origin.host.toLowerCase() !== hostHeader
      ) {
        error(res, 403, 'unexpected origin')
        return false
      }
    } catch {
      error(res, 403, 'unexpected origin')
      return false
    }
    return true
  }

  function mutationIsAuthorized(req, res) {
    if (!requestIsSameOrigin(req, res)) return false
    if (req.headers['x-csrf-token'] !== csrfToken) {
      error(res, 403, 'invalid csrf token')
      return false
    }
    return true
  }

  function assetHeaders(contentType) {
    return {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    }
  }

  function htmlHeaders() {
    return {
      ...assetHeaders('text/html; charset=utf-8'),
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
    }
  }

  async function handler(req, res) {
    if (!requestIsSameOrigin(req, res)) return
    const method = req.method ?? 'GET'
    let url
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    } catch {
      error(res, 400, 'invalid URL')
      return
    }
    const pathname = url.pathname

    if (method === 'GET' && pathname === '/_health') {
      const pandoc = await pandocIsAvailable()
      json(res, 200, {
        status: pandoc ? 'ok' : 'degraded',
        service: 'plan-manager',
        version: 1,
        url: `http://plans.localhost:${actualPort}/`,
        host,
        port: actualPort,
        planHome,
        pandoc: pandoc ? 'available' : 'unavailable',
        sequence,
        fingerprint: currentSnapshot.fingerprint,
      })
      return
    }

    if (method === 'GET' && pathname === '/_session') {
      json(res, 200, {
        csrfToken,
        sequence,
        fingerprint: currentSnapshot.fingerprint,
      })
      return
    }

    if (method === 'GET' && pathname === '/_events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const lastEventId = Number.parseInt(req.headers['last-event-id'] ?? '0', 10) || 0
      res.write(`retry: 1000\nevent: connected\ndata: ${JSON.stringify({
        sequence,
        fingerprint: currentSnapshot.fingerprint,
        missed: lastEventId < sequence,
      })}\n\n`)
      clients.add(res)
      req.once('close', () => clients.delete(res))
      return
    }

    if (method === 'GET' && pathname === '/api/plans') {
      const { plans, malformed } = await indexPlans()
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const matches = query
        ? plans.filter(plan =>
            plan.meta.title.toLowerCase().includes(query) ||
            plan.meta.tags.some(tag => tag.toLowerCase().includes(query)) ||
            plan.body.toLowerCase().includes(query)
          )
        : plans
      json(res, 200, {
        plans: matches.map(plan => ({
          id: plan.meta.id,
          title: plan.meta.title,
          status: plan.meta.status,
          created: plan.meta.created,
          updated: plan.meta.updated,
          tags: plan.meta.tags,
          revision: plan.revision,
          url: `/plans/${encodeURIComponent(plan.meta.id)}`,
          isArchived: plan.isArchived,
        })),
        malformed,
        sequence,
        fingerprint: currentSnapshot.fingerprint,
      })
      return
    }

    if (method === 'GET' && pathname === '/api/search') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const { plans, malformed } = await indexPlans()
      const matches = query
        ? plans.filter(plan =>
            plan.meta.title.toLowerCase().includes(query) ||
            plan.meta.tags.some(tag => tag.toLowerCase().includes(query)) ||
            plan.body.toLowerCase().includes(query)
          )
        : plans
      json(res, 200, {
        plans: matches.map(plan => ({
          id: plan.meta.id,
          title: plan.meta.title,
          status: plan.meta.status,
          created: plan.meta.created,
          updated: plan.meta.updated,
          tags: plan.meta.tags,
          revision: plan.revision,
          url: `/plans/${encodeURIComponent(plan.meta.id)}`,
          isArchived: plan.isArchived,
        })),
        malformed,
        sequence,
        fingerprint: currentSnapshot.fingerprint,
      })
      return
    }

    const detailMatch = pathname.match(/^\/api\/plans\/([^/]+)$/)
    if (method === 'GET' && detailMatch) {
      let id
      try {
        id = decodeURIComponent(detailMatch[1])
      } catch {
        error(res, 400, 'invalid plan ID')
        return
      }
      let plan
      try {
        plan = await findPlan(id)
      } catch (planError) {
        error(res, planError.code === 'EDUPLICATE' ? 409 : 500, planError.message)
        return
      }
      if (!plan) {
        error(res, 404, 'plan not found')
        return
      }
      let html = null
      let renderState = 'unavailable'
      if (plan.format === 'mdx') {
        try {
          html = renderMdxToHtml(plan.body)
          renderState = 'rendered'
        } catch {
          renderState = 'failed'
        }
      } else if (await pandocIsAvailable()) {
        try {
          html = await renderMarkdown(plan.body)
          renderState = 'rendered'
        } catch {
          renderState = 'failed'
        }
      }
      json(res, 200, {
        id: plan.meta.id,
        title: plan.meta.title,
        status: plan.meta.status,
        created: plan.meta.created,
        updated: plan.meta.updated,
        tags: plan.meta.tags,
        revision: plan.revision,
        format: plan.format,
        body: plan.body,
        html,
        renderState,
        filePath: plan.filePath,
        url: `/plans/${encodeURIComponent(plan.meta.id)}`,
        isArchived: plan.isArchived,
        sequence,
      })
      return
    }

    const statusMatch = pathname.match(/^\/api\/plans\/([^/]+)\/status$/)
    if (method === 'POST' && statusMatch) {
      if (!mutationIsAuthorized(req, res)) return
      let body
      try {
        body = parseJson(await readBody(req))
      } catch (bodyError) {
        error(res, bodyError.code === 'ETOOLARGE' ? 413 : 400, bodyError.message)
        return
      }
      if (!body || !STATUS_VALUES.has(body.status)) {
        error(res, 400, 'invalid status')
        return
      }
      const id = decodeURIComponent(statusMatch[1])
      let updated
      try {
        updated = await withPlanWriteLock(async () => {
          const plan = await findPlan(id)
          if (!plan) return null
          return atomicPlanWrite(plan.filePath, { ...plan.meta, status: body.status }, plan.body)
        }, planHome)
      } catch (writeError) {
        if (writeError.code === 'ELOCKTIMEOUT') {
          error(res, 409, writeError.message)
          return
        }
        throw writeError
      }
      if (!updated) {
        error(res, 404, 'plan not found')
        return
      }
      scheduleScan()
      json(res, 200, {
        id,
        status: updated.meta.status,
        revision: updated.revision,
        url: `/plans/${encodeURIComponent(id)}`,
      })
      return
    }

    const taskMatch = pathname.match(/^\/api\/plans\/([^/]+)\/tasks\/(\d+)$/)
    if (method === 'POST' && taskMatch) {
      if (!mutationIsAuthorized(req, res)) return
      let body
      try {
        body = parseJson(await readBody(req))
      } catch (bodyError) {
        error(res, bodyError.code === 'ETOOLARGE' ? 413 : 400, bodyError.message)
        return
      }
      if (!body || typeof body.checked !== 'boolean' || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/i.test(body.revision)) {
        error(res, 400, 'invalid task update')
        return
      }
      let id
      try {
        id = decodeURIComponent(taskMatch[1])
      } catch {
        error(res, 400, 'invalid plan ID')
        return
      }
      const index = Number(taskMatch[2])
      if (!Number.isSafeInteger(index)) {
        error(res, 400, 'invalid task index')
        return
      }
      let taskState
      try {
        taskState = await withPlanWriteLock(async () => {
          const plan = await findPlan(id)
          if (!plan) return { state: 'not-found' }
          if (plan.revision !== body.revision) return { state: 'stale' }
          const nextBody = updateTaskMarker(plan.body, index, body.checked)
          if (nextBody === null) return { state: 'invalid-index' }
          return { state: 'updated', plan: await atomicPlanWrite(plan.filePath, plan.meta, nextBody) }
        }, planHome)
      } catch (writeError) {
        if (writeError.code === 'ELOCKTIMEOUT') {
          error(res, 409, writeError.message)
          return
        }
        throw writeError
      }
      if (taskState.state === 'not-found') {
        error(res, 404, 'plan not found')
        return
      }
      if (taskState.state === 'stale') {
        error(res, 409, 'stale plan revision')
        return
      }
      if (taskState.state === 'invalid-index') {
        error(res, 400, 'invalid task index')
        return
      }
      scheduleScan()
      json(res, 200, {
        id,
        index,
        checked: body.checked,
        revision: taskState.plan.revision,
        url: `/plans/${encodeURIComponent(id)}`,
      })
      return
    }

    const archiveMatch = pathname.match(/^\/api\/plans\/([^/]+)\/archive$/)
    if (method === 'POST' && archiveMatch) {
      if (!mutationIsAuthorized(req, res)) return
      const id = decodeURIComponent(archiveMatch[1])
      let archiveState
      try {
        archiveState = await withPlanWriteLock(async () => {
          const plan = await findPlan(id)
          if (!plan) return { state: 'not-found' }
          if (plan.isArchived) return { state: 'archived' }
          const destination = join(archiveHome, basename(plan.filePath))
          try {
            await lstat(destination)
            return { state: 'collision' }
          } catch (destinationError) {
            if (destinationError.code !== 'ENOENT') throw destinationError
          }
          await atomicPlanWrite(plan.filePath, { ...plan.meta, status: 'archived' }, plan.body)
          await rename(plan.filePath, destination)
          return { state: 'archived' }
        }, planHome)
      } catch (writeError) {
        if (writeError.code === 'ELOCKTIMEOUT') {
          error(res, 409, writeError.message)
          return
        }
        throw writeError
      }
      if (archiveState.state === 'not-found') {
        error(res, 404, 'plan not found')
        return
      }
      if (archiveState.state === 'collision') {
        error(res, 409, 'archive destination already exists')
        return
      }
      scheduleScan()
      json(res, 200, {
        id,
        archived: true,
        url: `/plans/${encodeURIComponent(id)}`,
      })
      return
    }

    const copyMatch = pathname.match(/^\/api\/plans\/([^/]+)\/copy-path$/)
    if (method === 'POST' && copyMatch) {
      if (!mutationIsAuthorized(req, res)) return
      const id = decodeURIComponent(copyMatch[1])
      const plan = await findPlan(id).catch(() => null)
      if (!plan) {
        error(res, 404, 'plan not found')
        return
      }
      json(res, 200, { id, path: plan.filePath })
      return
    }

    const editorMatch = pathname.match(/^\/api\/plans\/([^/]+)\/open-in-editor$/)
    if (method === 'POST' && editorMatch) {
      if (!mutationIsAuthorized(req, res)) return
      const id = decodeURIComponent(editorMatch[1])
      const plan = await findPlan(id).catch(() => null)
      if (!plan) {
        error(res, 404, 'plan not found')
        return
      }
      const editor = process.env.EDITOR || 'open'
      const child = spawn(editor, [plan.filePath], {
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', () => {})
      child.unref()
      json(res, 200, { id, opened: true })
      return
    }

    const dashboardRoot = new URL('../dashboard/', import.meta.url)
    const assets = new Map([
      ['/', ['index.html', htmlHeaders()]],
      ['/icon.png', ['icon.png', assetHeaders('image/png')]],
      ['/style.css', ['style.css', assetHeaders('text/css; charset=utf-8')]],
      ['/app.js', ['app.js', assetHeaders('application/javascript; charset=utf-8')]],
      ['/plan.js', ['plan.js', assetHeaders('application/javascript; charset=utf-8')]],
    ])
    const planPageMatch = pathname.match(/^\/plans\/[^/]+$/)
    if (method === 'GET' && planPageMatch) {
      const content = await readFile(new URL('plan.html', dashboardRoot), 'utf8')
      res.writeHead(200, htmlHeaders())
      res.end(content)
      return
    }
    if (method === 'GET' && assets.has(pathname)) {
      const [filename, headers] = assets.get(pathname)
      const content = await readFile(new URL(filename, dashboardRoot))
      res.writeHead(200, headers)
      res.end(content)
      return
    }

    error(res, 404, 'not found')
  }

  const server = createServer((req, res) => {
    handler(req, res).catch(requestError => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      error(res, requestError.code === 'ETOOLARGE' ? 413 : 500, 'internal server error')
    })
  })

  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', listenError => {
        if (listenError.code === 'EADDRINUSE') {
          const collisionError = new Error(`Port ${requestedPort} is already in use`)
          collisionError.code = 'EADDRINUSE'
          collisionError.exitCode = 9
          reject(collisionError)
          return
        }
        reject(listenError)
      })
      server.listen(requestedPort, host, resolvePromise)
    })
  } catch (listenError) {
    server.close()
    throw listenError
  }

  actualPort = server.address().port
  if (watchEnabled) {
    fileWatcher = watch(planHome, { recursive: true }, scheduleScan)
    fileWatcher.once('error', () => {
      fileWatcher?.close()
      fileWatcher = null
    })
  }
  reconcileTimer = setInterval(() => stableScan().catch(() => {}), reconcileInterval)
  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        clients.delete(client)
      }
    }
  }, 15000)

  async function close() {
    if (closed) return
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (reconcileTimer) clearInterval(reconcileTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    fileWatcher?.close()
    for (const client of clients) client.end()
    clients.clear()
    await new Promise(resolvePromise => server.close(resolvePromise))
  }

  return {
    url: `http://plans.localhost:${actualPort}`,
    host,
    port: actualPort,
    close,
    reconcile: stableScan,
  }
}
