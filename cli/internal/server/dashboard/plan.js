const state = {
  id: decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1)),
  plan: null,
  csrfToken: null,
}
const hosted = document.documentElement.dataset.dashboardEnvironment === 'hosted'

const detailElement = document.querySelector('#detail')
const liveDot = document.querySelector('#live-dot')
const liveLabel = document.querySelector('#live-label')

async function request(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method === 'POST' ? { 'X-CSRF-Token': state.csrfToken } : {}),
      ...options.headers,
    },
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `Request failed with ${response.status}`)
  return value
}

function toast(message, kind = 'success') {
  const element = document.createElement('div')
  element.className = `toast ${kind}`
  element.textContent = message
  document.querySelector('#toasts').append(element)
  setTimeout(() => element.remove(), 3500)
}

function button(label, action, className = 'btn') {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.addEventListener('click', action)
  return element
}

function badge(status) {
  const element = document.createElement('span')
  element.className = `status-badge ${status}`
  element.textContent = status
  return element
}

async function mutate(suffix, options = {}) {
  return request(`/api/plans/${encodeURIComponent(state.id)}/${suffix}`, {
    method: 'POST',
    ...options,
  })
}

async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(state.plan.body)
    toast('Markdown copied')
  } catch {
    toast('Could not copy Markdown', 'error')
  }
}

async function copyPath() {
  try {
    const value = await mutate('copy-path')
    await navigator.clipboard.writeText(value.path)
    toast('Path copied')
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function openInEditor() {
  try {
    await mutate('open-in-editor')
    toast('Opened in editor')
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function setStatus(status) {
  try {
    await mutate('status', { body: JSON.stringify({ status }) })
    await loadPlan()
    toast(`Marked ${status}`)
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function archivePlan() {
  if (!window.confirm(`Archive “${state.plan.title}”?`)) return
  try {
    await mutate('archive')
    await loadPlan()
    toast('Plan archived')
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function toggleTask(input, index, inputs) {
  inputs.forEach(item => { item.disabled = true })
  try {
    await mutate(`tasks/${index}`, {
      body: JSON.stringify({
        checked: input.checked,
        revision: state.plan.revision,
      }),
    })
    await loadPlan()
    toast('Task updated')
  } catch (requestError) {
    await loadPlan().catch(() => {})
    toast(requestError.message, 'error')
  }
}

function enableTaskCheckboxes(body) {
  const inputs = [...body.querySelectorAll('input[data-plan-task="true"]')]
  inputs.forEach((input, index) => {
    input.disabled = false
    input.setAttribute('aria-label', `Toggle task ${index + 1}`)
    input.addEventListener('change', () => toggleTask(input, index, inputs))
  })
}

function metaCell(label, modifier, ...values) {
  const cell = document.createElement('div')
  cell.className = modifier ? `meta ${modifier}` : 'meta'
  const name = document.createElement('span')
  name.className = 'meta-label'
  name.textContent = label
  const value = document.createElement('span')
  value.className = 'meta-value'
  value.append(...values)
  cell.append(name, value)
  return cell
}

function render() {
  const plan = state.plan
  document.title = `${plan.title} · Plan Library`
  detailElement.replaceChildren()

  const header = document.createElement('header')
  header.className = 'hero detail-hero'
  const eyebrow = document.createElement('p')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = 'Plan record'
  const title = document.createElement('h1')
  title.textContent = plan.title
  header.append(eyebrow, title)

  const date = document.createElement('time')
  date.className = 'plan-date'
  date.dateTime = plan.updated
  date.textContent = new Date(plan.updated).toLocaleString()

  const tags = document.createElement('span')
  tags.className = 'plan-meta'
  for (const tag of plan.tags) {
    const tagElement = document.createElement('span')
    tagElement.className = 'plan-tag'
    tagElement.textContent = tag
    tags.append(tagElement)
  }
  if (plan.tags.length === 0) tags.textContent = '—'

  const revision = document.createElement('span')
  revision.className = 'rev'
  revision.textContent = String(plan.revision).slice(0, 8)
  revision.title = String(plan.revision)

  const metadata = document.createElement('div')
  metadata.className = 'metadata'
  metadata.append(
    metaCell('Status', `is-${plan.status}`, badge(plan.status)),
    metaCell('Updated', null, date),
    metaCell('Tags', null, tags),
    metaCell('Revision', null, revision),
  )

  const actions = document.createElement('div')
  actions.className = 'detail-actions'
  const status = document.createElement('select')
  status.className = 'status-select'
  status.setAttribute('aria-label', 'Plan status')
  for (const value of ['active', 'completed', 'archived']) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    option.selected = plan.status === value
    status.append(option)
  }
  status.addEventListener('change', () => setStatus(status.value))
  actions.append(
    status,
    button('Copy Markdown', copyMarkdown),
    button('Copy path', copyPath),
    button('Open in editor', openInEditor),
  )
  if (!plan.isArchived) actions.append(button('Archive', archivePlan, 'btn danger'))

  const sheet = document.createElement('div')
  sheet.className = 'document'
  const body = document.createElement('article')
  if (plan.html !== null) {
    body.className = 'markdown-body'
    body.innerHTML = plan.html
    enableTaskCheckboxes(body)
  } else {
    body.className = 'markdown-fallback'
    body.textContent = plan.body
  }
  sheet.append(body)
  detailElement.append(header, metadata, actions, sheet)
}

async function loadPlan() {
  const plan = await request(`/api/plans/${encodeURIComponent(state.id)}`)
  state.plan = plan
  render()
}

async function reconcileHostedRevision() {
  if (!state.plan) return
  try {
    const latest = await request(`/api/plans/${encodeURIComponent(state.id)}`)
    if (latest.revision !== state.plan.revision) window.location.reload()
  } catch {
    liveDot.classList.add('disconnected')
    liveLabel.textContent = 'Unavailable'
  }
}

async function reconcileRevision() {
  if (!state.plan) return
  try {
    const latest = await request(`/api/plans/${encodeURIComponent(state.id)}`)
    if (latest.revision !== state.plan.revision) window.location.reload()
  } catch {
    window.location.reload()
  }
}

function connectEvents() {
  if (hosted) {
    liveDot.classList.remove('disconnected')
    liveLabel.textContent = 'Checking for updates'
    setInterval(reconcileHostedRevision, 15000)
    return
  }
  const events = new EventSource('/_events')
  events.addEventListener('open', () => {
    liveDot.classList.remove('disconnected')
    liveLabel.textContent = 'Live'
  })
  events.addEventListener('error', () => {
    liveDot.classList.add('disconnected')
    liveLabel.textContent = 'Reconnecting'
  })
  events.addEventListener('connected', reconcileRevision)
  events.addEventListener('plan', event => {
    const value = JSON.parse(event.data)
    if (value.id === state.id && value.revision !== state.plan?.revision) {
      window.location.reload()
    }
  })
  events.addEventListener('library', event => {
    const value = JSON.parse(event.data)
    if (value.removed.includes(state.id)) window.location.reload()
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconcileRevision()
})

async function start() {
  try {
    if (hosted) {
      state.plan = { revision: detailElement.dataset.revision }
      document.title = `${detailElement.querySelector('h1')?.textContent ?? 'Plan'} · Plan Library`
      for (const footer of document.querySelectorAll('footer span:last-child')) {
        footer.textContent = 'Private · Owner access'
      }
      connectEvents()
      return
    }
    const session = await request('/_session')
    state.csrfToken = session.csrfToken
    await loadPlan()
    connectEvents()
  } catch (requestError) {
    const failure = document.createElement('div')
    failure.className = 'empty-state'
    const heading = document.createElement('h3')
    heading.textContent = 'Plan unavailable'
    const text = document.createElement('p')
    text.textContent = requestError.message
    failure.append(heading, text)
    detailElement.replaceChildren(failure)
    toast(requestError.message, 'error')
  }
}

start()
