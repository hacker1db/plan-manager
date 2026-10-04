import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { request as httpRequest } from 'node:http'

import { startServer } from '../../dist/server/server.js'

const fixtures = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

async function fixture() {
  const pathname = await mkdtemp(join(tmpdir(), 'plan-dashboard-'))
  fixtures.push(pathname)
  return pathname
}

function markdown({
  id = 'plan_test',
  title = 'Test plan',
  status = 'active',
  tags = ['test'],
  body = '# Test\n\nInitial body.',
} = {}) {
  return `---
id: ${id}
title: ${title}
status: ${status}
created: '2026-07-25T00:00:00.000Z'
updated: '2026-07-25T00:00:00.000Z'
tags:
${tags.map(tag => `  - ${tag}`).join('\n')}
---
${body}
`
}

async function running(options = {}) {
  const planHome = options.planHome ?? await fixture()
  const server = await startServer({
    planHome,
    port: 0,
    watchDebounceMs: 50,
    stabilityDelayMs: 25,
    reconcileIntervalMs: 1000,
    ...options,
  })
  servers.push(server)
  return {
    planHome,
    server,
    base: `http://127.0.0.1:${server.port}`,
  }
}

async function value(response) {
  const body = await response.json()
  return { response, body }
}

async function rawRequest({ port, path = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

class EventReader {
  constructor(response, controller) {
    this.reader = response.body.getReader()
    this.controller = controller
    this.decoder = new TextDecoder()
    this.buffer = ''
    this.events = []
  }

  async next(type, timeoutMs = 3000) {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    })
    return Promise.race([this.#read(type), timeout])
  }

  async #read(type) {
    while (true) {
      const existing = this.events.findIndex(event => event.type === type)
      if (existing >= 0) return this.events.splice(existing, 1)[0]
      const { value: chunk, done } = await this.reader.read()
      if (done) throw new Error('Event stream closed')
      this.buffer += this.decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n')
      let boundary
      while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
        const wire = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        const event = { type: 'message', id: null, data: null }
        const data = []
        for (const line of wire.split('\n')) {
          if (line.startsWith('event:')) event.type = line.slice(6).trim()
          if (line.startsWith('id:')) event.id = Number.parseInt(line.slice(3).trim(), 10)
          if (line.startsWith('data:')) data.push(line.slice(5).trim())
        }
        if (data.length > 0) event.data = JSON.parse(data.join('\n'))
        this.events.push(event)
      }
    }
  }

  close() {
    this.controller.abort()
  }
}

async function events(base, headers = {}) {
  const controller = new AbortController()
  const response = await fetch(`${base}/_events`, {
    headers,
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  return new EventReader(response, controller)
}

test('health identifies a loopback-only plan-manager service', async () => {
  const { planHome, server, base } = await running()
  const { response, body } = await value(await fetch(`${base}/_health`))
  assert.equal(response.status, 200)
  assert.equal(body.service, 'plan-manager')
  assert.equal(body.version, 1)
  assert.equal(body.host, '127.0.0.1')
  assert.equal(body.port, server.port)
  assert.equal(body.planHome, planHome)
  assert.equal(body.url, `http://plans.localhost:${server.port}/`)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('unsafe bind addresses and fixed-port collisions fail visibly', async () => {
  const root = await fixture()
  await assert.rejects(
    startServer({ planHome: root, port: 0, host: '0.0.0.0' }),
    error => error.code === 'EHOSTUNSAFE',
  )

  const first = await startServer({ planHome: root, port: 0 })
  servers.push(first)
  await assert.rejects(
    startServer({ planHome: root, port: first.port }),
    error => error.code === 'EADDRINUSE' && error.exitCode === 9,
  )
})

test('Host and Origin checks enforce exact same-origin without CORS', async () => {
  const { server, base } = await running()
  const wrongHost = await rawRequest({
    port: server.port,
    path: '/_health',
    headers: { Host: `plans.localhost:${server.port + 1}` },
  })
  assert.equal(wrongHost.status, 421)

  const wrongOrigin = await fetch(`${base}/_health`, {
    headers: { Origin: `http://localhost:${server.port}` },
  })
  assert.equal(wrongOrigin.status, 403)

  const matchingOrigin = await fetch(`${base}/_health`, {
    headers: { Origin: base },
  })
  assert.equal(matchingOrigin.status, 200)

  const preflight = await fetch(`${base}/api/plans`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com' },
  })
  assert.equal(preflight.status, 403)
  assert.equal(preflight.headers.get('access-control-allow-origin'), null)
})

test('mutations require CSRF and leave files unchanged when rejected', async () => {
  const root = await fixture()
  const filePath = join(root, 'test.md')
  const original = markdown()
  await writeFile(filePath, original)
  const { base } = await running({ planHome: root })
  const session = await fetch(`${base}/_session`).then(response => response.json())

  const absent = await fetch(`${base}/api/plans/plan_test/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(absent.status, 403)
  assert.equal(await readFile(filePath, 'utf8'), original)

  const crossOrigin = await fetch(`${base}/api/plans/plan_test/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      Origin: 'https://example.com',
    },
  })
  assert.equal(crossOrigin.status, 403)
  assert.equal(await readFile(filePath, 'utf8'), original)

  const accepted = await fetch(`${base}/api/plans/plan_test/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      Origin: base,
    },
  })
  assert.equal(accepted.status, 200)
  const updated = await readFile(filePath, 'utf8')
  assert.match(updated, /^---\n/)
  assert.match(updated, /\nstatus: completed\n/)
  assert.match(updated, /\n---\n\n# Test\n\nInitial body\.\n$/)
})

test('oversized and malformed mutation bodies are rejected', async () => {
  const root = await fixture()
  await writeFile(join(root, 'test.md'), markdown())
  const { base } = await running({ planHome: root })
  const session = await fetch(`${base}/_session`).then(response => response.json())
  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
  }

  const malformed = await fetch(`${base}/api/plans/plan_test/status`, {
    method: 'POST',
    headers,
    body: '{',
  })
  assert.equal(malformed.status, 400)

  const oversized = await fetch(`${base}/api/plans/plan_test/status`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'active', padding: 'x'.repeat(70 * 1024) }),
  })
  assert.equal(oversized.status, 413)
})

test('task toggles persist one Markdown marker with CSRF and revision checks', async () => {
  const root = await fixture()
  const filePath = join(root, 'tasks.md')
  await writeFile(filePath, markdown({
    id: 'task_plan',
    body: '# Tasks\n\n- [ ] First task\n- [x] Second task\n\nUnrelated text.',
  }))
  const { base } = await running({ planHome: root })
  const session = await fetch(`${base}/_session`).then(response => response.json())
  const detail = await fetch(`${base}/api/plans/task_plan`).then(response => response.json())
  assert.match(detail.html, /<input type="checkbox" data-plan-task="true">/)
  assert.match(detail.html, /<input type="checkbox" data-plan-task="true" checked>/)

  const rejected = await fetch(`${base}/api/plans/task_plan/tasks/0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checked: true, revision: detail.revision }),
  })
  assert.equal(rejected.status, 403)

  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
  }
  const updated = await fetch(`${base}/api/plans/task_plan/tasks/0`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ checked: true, revision: detail.revision }),
  }).then(response => value(response))
  assert.equal(updated.response.status, 200)
  assert.notEqual(updated.body.revision, detail.revision)
  const afterUpdate = await readFile(filePath, 'utf8')
  assert.match(afterUpdate, /- \[x\] First task\n- \[x\] Second task\n\nUnrelated text\./)

  const stale = await fetch(`${base}/api/plans/task_plan/tasks/1`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ checked: false, revision: detail.revision }),
  })
  assert.equal(stale.status, 409)

  const invalid = await fetch(`${base}/api/plans/task_plan/tasks/9`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ checked: false, revision: updated.body.revision }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(await readFile(filePath, 'utf8'), afterUpdate)
})

test('copy-path and editor actions are contained and CSRF protected', async () => {
  const root = await fixture()
  const filePath = join(root, 'actions.md')
  await writeFile(filePath, markdown({ id: 'action_plan' }))
  const previousEditor = process.env.EDITOR
  process.env.EDITOR = '/usr/bin/true'
  try {
    const { base } = await running({ planHome: root })
    const session = await fetch(`${base}/_session`).then(response => response.json())
    const rejected = await fetch(`${base}/api/plans/action_plan/copy-path`, {
      method: 'POST',
    })
    assert.equal(rejected.status, 403)

    const headers = { 'X-CSRF-Token': session.csrfToken }
    const copied = await fetch(`${base}/api/plans/action_plan/copy-path`, {
      method: 'POST',
      headers,
    }).then(response => response.json())
    assert.equal(copied.path, filePath)

    const opened = await fetch(`${base}/api/plans/action_plan/open-in-editor`, {
      method: 'POST',
      headers,
    })
    assert.equal(opened.status, 200)
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = previousEditor
  }
})

test('encoded traversal identifiers and duplicate IDs never select a file', async () => {
  const root = await fixture()
  await writeFile(join(root, 'one.md'), markdown({ id: 'duplicate_plan', title: 'One' }))
  await writeFile(join(root, 'two.md'), markdown({ id: 'duplicate_plan', title: 'Two' }))
  const { base } = await running({ planHome: root })

  const duplicate = await fetch(`${base}/api/plans/duplicate_plan`)
  assert.equal(duplicate.status, 409)

  const traversal = await fetch(`${base}/api/plans/%2e%2e%2Foutside`)
  assert.equal(traversal.status, 404)
})

test('malformed files and symlinks are isolated from the library', async () => {
  const root = await fixture()
  const outside = join(await fixture(), 'outside.md')
  await writeFile(join(root, 'valid.md'), markdown())
  await writeFile(join(root, 'malformed.md'), '---\nid: [\n---\nsecret')
  await writeFile(outside, markdown({ id: 'outside_plan', body: 'outside secret' }))
  await symlink(outside, join(root, 'linked.md'))
  const { base } = await running({ planHome: root })

  const library = await fetch(`${base}/api/plans`).then(response => response.json())
  assert.deepEqual(library.plans.map(plan => plan.id), ['plan_test'])
  assert.deepEqual(library.malformed.map(item => item.file), ['malformed.md'])
  assert.doesNotMatch(JSON.stringify(library), /outside secret/)
  const outsideResponse = await fetch(`${base}/api/plans/outside_plan`)
  assert.equal(outsideResponse.status, 404)
})

test('search covers title, tags, and Markdown body', async () => {
  const root = await fixture()
  await writeFile(join(root, 'alpha.md'), markdown({
    id: 'plan_alpha',
    title: 'Migration map',
    tags: ['backend'],
    body: 'Contains a telescope phrase.',
  }))
  await writeFile(join(root, 'beta.md'), markdown({
    id: 'plan_beta',
    title: 'Frontend',
    tags: ['accessibility'],
    body: 'Second plan.',
  }))
  const { base } = await running({ planHome: root })

  for (const [query, expected] of [
    ['migration', 'plan_alpha'],
    ['backend', 'plan_alpha'],
    ['telescope', 'plan_alpha'],
    ['accessibility', 'plan_beta'],
  ]) {
    const result = await fetch(`${base}/api/search?q=${query}`).then(response => response.json())
    assert.deepEqual(result.plans.map(plan => plan.id), [expected])
    const sharedContract = await fetch(`${base}/api/plans?q=${query}`).then(response => response.json())
    assert.deepEqual(sharedContract.plans.map(plan => plan.id), [expected])
  }
})

test('stable ID routes survive status changes and archive moves', async () => {
  const root = await fixture()
  await writeFile(join(root, 'renameable.md'), markdown({ id: 'stable_plan' }))
  const { base } = await running({ planHome: root })
  const session = await fetch(`${base}/_session`).then(response => response.json())
  const headers = { 'X-CSRF-Token': session.csrfToken }
  const route = `${base}/plans/stable_plan?view=review`

  assert.equal((await fetch(route)).status, 200)
  assert.equal((await fetch(`${base}/api/plans/stable_plan/status`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }),
  })).status, 200)
  assert.equal((await fetch(route)).status, 200)
  assert.equal((await fetch(`${base}/api/plans/stable_plan/archive`, {
    method: 'POST',
    headers,
  })).status, 200)
  assert.equal((await fetch(route)).status, 200)
  const detail = await fetch(`${base}/api/plans/stable_plan`).then(response => response.json())
  assert.equal(detail.id, 'stable_plan')
  assert.equal(detail.status, 'archived')
  assert.equal(detail.isArchived, true)
})

test('Pandoc rendering removes active HTML and unsafe URL schemes', async () => {
  const root = await fixture()
  await writeFile(join(root, 'unsafe.md'), markdown({
    id: 'unsafe_plan',
    body: '# Safe\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n<input type="checkbox" checked>\n\n<form><button>bad</button></form>',
  }))
  const { base } = await running({ planHome: root })
  const detail = await fetch(`${base}/api/plans/unsafe_plan`).then(response => response.json())
  assert.equal(detail.renderState, 'rendered')
  assert.match(detail.html, /<h1[^>]*>Safe<\/h1>/)
  assert.doesNotMatch(detail.html, /<script|javascript:|onerror=|<input|<form|<button/i)
})

test('raw_attribute blocks span injection that the regex sanitizer cannot catch', async () => {
  // The test above only proves pandoc's -raw_html works: those payloads are
  // neutralized before sanitizeRenderedHtml ever runs. These use pandoc's
  // raw_attribute extension, which -raw_html does NOT disable, and each one
  // defeats a specific sanitizer rule — so they reach the DOM intact unless
  // the reader spec also disables raw_attribute.
  const root = await fixture()
  await writeFile(join(root, 'raw.md'), markdown({
    id: 'raw_plan',
    body: [
      '# Safe',
      '',
      // `/` is a valid attribute separator, but the handler regex requires \s+
      '`<img src="x"/onerror=alert(1)>`{=html}',
      '',
      // namespaced attribute escapes the (href|src) scheme filter
      '`<svg><a xlink:href="javascript:alert(1)">x</a></svg>`{=html}',
      '',
      // no rule strips style=, and none of these tags are in the blocklist
      '`<p style="background:url(http://evil.example/x)">x</p>`{=html}',
      '',
      '`<link rel="stylesheet" href="http://evil.example/x.css">`{=html}',
      '',
      // class injection lets plan content impersonate the app's own fixed-position chrome
      '`<div class="toast-container"><div class="toast error">fake</div></div>`{=html}',
    ].join('\n'),
  }))
  const { base } = await running({ planHome: root })
  const detail = await fetch(`${base}/api/plans/raw_plan`).then(response => response.json())

  assert.equal(detail.renderState, 'rendered')
  assert.match(detail.html, /<h1[^>]*>Safe<\/h1>/)

  // Assert on live ELEMENTS, not substrings: the payload text legitimately
  // survives as escaped character data inside <code>, so matching /onerror=/
  // would fail on correct output. What must not exist is a real tag.
  assert.doesNotMatch(detail.html, /<img\b/i)
  assert.doesNotMatch(detail.html, /<svg\b/i)
  assert.doesNotMatch(detail.html, /<link\b/i)
  assert.doesNotMatch(detail.html, /<a\b[^>]*xlink/i)
  assert.doesNotMatch(detail.html, /<[a-z]+\b[^>]*\sstyle=/i)
  assert.doesNotMatch(detail.html, /<[a-z]+\b[^>]*class="toast/i)

  // Neutralized by escaping into text, not by being silently dropped —
  // the author's prose is preserved verbatim.
  assert.match(detail.html, /&lt;img src="x"\/onerror=alert\(1\)&gt;/)
  assert.match(detail.html, /&lt;div class="toast-container"&gt;/)
})

test('SSE emits stable monotonic library and plan revisions', async () => {
  const root = await fixture()
  const filePath = join(root, 'live.md')
  await writeFile(filePath, markdown({ id: 'live_plan' }))
  const { base } = await running({ planHome: root })
  const stream = await events(base)
  await stream.next('connected')

  const finalMarkdown = markdown({ id: 'live_plan', body: '# Updated\n\nFinal body.' })
  await writeFile(filePath, '---\nid: incomplete')
  await new Promise(resolve => setTimeout(resolve, 20))
  await writeFile(filePath, finalMarkdown)

  const libraryEvent = await stream.next('library')
  const planEvent = await stream.next('plan')
  assert.ok(Number.isInteger(libraryEvent.id))
  assert.ok(planEvent.id > libraryEvent.id)
  assert.deepEqual(libraryEvent.data.changed.map(item => item.id), ['live_plan'])
  assert.equal(planEvent.data.id, 'live_plan')
  const detail = await fetch(`${base}/api/plans/live_plan`).then(response => response.json())
  assert.equal(planEvent.data.revision, detail.revision)
  stream.close()
})

test('periodic reconciliation recovers missed watcher events and reconnects stale clients', async () => {
  const root = await fixture()
  const filePath = join(root, 'wake.md')
  await writeFile(filePath, markdown({ id: 'wake_plan' }))
  const { base, server } = await running({
    planHome: root,
    watch: false,
    stabilityDelayMs: 10,
    reconcileIntervalMs: 60,
  })
  const firstStream = await events(base)
  await firstStream.next('connected')
  await writeFile(filePath, markdown({ id: 'wake_plan', body: '# Revision two' }))
  const changed = await firstStream.next('plan')
  firstStream.close()

  await writeFile(filePath, markdown({ id: 'wake_plan', body: '# Revision three' }))
  await server.reconcile()
  const reconnected = await events(base, { 'Last-Event-ID': String(changed.id) })
  const connected = await reconnected.next('connected')
  assert.equal(connected.data.missed, true)
  const detail = await fetch(`${base}/api/plans/wake_plan`).then(response => response.json())
  assert.match(detail.body, /Revision three/)
  reconnected.close()
})

test('dashboard assets provide responsive actions and same-route refresh logic', async () => {
  const root = await fixture()
  await writeFile(join(root, 'ui.md'), markdown({ id: 'ui_plan' }))
  const { base } = await running({ planHome: root })

  const index = await fetch(`${base}/`).then(async response => ({
    status: response.status,
    csp: response.headers.get('content-security-policy'),
    body: await response.text(),
  }))
  assert.equal(index.status, 200)
  assert.match(index.csp, /default-src 'self'/)
  assert.match(index.body, /Search plans/)
  assert.match(index.body, /data-status="active"/)
  assert.match(index.body, /rel="icon" href="\/icon\.png"/)

  const planPage = await fetch(`${base}/plans/ui_plan`).then(response => response.text())
  assert.match(planPage, /All plans/)
  assert.match(planPage, /rel="icon" href="\/icon\.png"/)

  const icon = await fetch(`${base}/icon.png`).then(async response => {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes,
    }
  })
  assert.equal(icon.status, 200)
  assert.equal(icon.contentType, 'image/png')
  assert.deepEqual([...icon.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])

  const appSource = await fetch(`${base}/app.js`).then(response => response.text())
  assert.match(appSource, /copy-path/)
  assert.match(appSource, /open-in-editor/)
  assert.match(appSource, /EventSource/)

  const planSource = await fetch(`${base}/plan.js`).then(response => response.text())
  assert.match(planSource, /window\.location\.reload\(\)/)
  assert.match(planSource, /value\.id === state\.id/)
  assert.match(planSource, /tasks\/\$\{index\}/)

  const css = await fetch(`${base}/style.css`).then(response => response.text())
  assert.match(css, /@media \(max-width: 720px\)/)
  assert.match(css, /data-plan-task/)
  assert.doesNotMatch(`${index.body}${planPage}${css}`, /https?:\/\/(?:fonts|cdn)\./i)
})
