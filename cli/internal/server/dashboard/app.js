const state = {
  plans: [],
  status: 'all',
  tag: null,
  query: '',
  csrfToken: null,
  fingerprint: null,
  searchTimer: null,
}
const hosted = document.documentElement.dataset.dashboardEnvironment === 'hosted'

const listElement = document.querySelector('#plan-list')
const searchElement = document.querySelector('#search')
const tagListElement = document.querySelector('#tag-list')
const summaryElement = document.querySelector('#result-summary')
const warningElement = document.querySelector('#malformed-warning')
const liveDot = document.querySelector('#live-dot')
const liveLabel = document.querySelector('#live-label')
const sidebar = document.querySelector('#sidebar')
const filterToggle = document.querySelector('#filter-toggle')

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
  element.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    action()
  })
  return element
}

function statusBadge(status) {
  const element = document.createElement('span')
  element.className = `status-badge ${status}`
  element.textContent = status
  return element
}

function filteredPlans() {
  return state.plans.filter(plan =>
    (state.status === 'all' || plan.status === state.status) &&
    (!state.tag || plan.tags.includes(state.tag))
  )
}

function updateCounts() {
  const counts = {
    all: state.plans.length,
    active: 0,
    completed: 0,
    archived: 0,
  }
  for (const plan of state.plans) counts[plan.status] += 1
  for (const [name, count] of Object.entries(counts)) {
    // Counts appear twice: the rail filters and the hero metadata strip.
    for (const element of document.querySelectorAll(`[data-count="${name}"]`)) {
      element.textContent = count
    }
  }
}

function renderTags() {
  const tags = [...new Set(state.plans.flatMap(plan => plan.tags))].sort()
  if (state.tag && !tags.includes(state.tag)) state.tag = null
  tagListElement.replaceChildren()
  for (const tag of tags) {
    const element = button(tag, () => {
      state.tag = state.tag === tag ? null : tag
      render()
    }, `tag-btn${state.tag === tag ? ' active' : ''}`)
    element.setAttribute('aria-pressed', String(state.tag === tag))
    tagListElement.append(element)
  }
  if (tags.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'filter-empty'
    empty.textContent = 'No tags'
    tagListElement.append(empty)
  }
}

async function changeStatus(plan, status) {
  try {
    await request(`/api/plans/${encodeURIComponent(plan.id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
    toast(`Marked “${plan.title}” ${status}`)
    await loadPlans()
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function archivePlan(plan) {
  if (!window.confirm(`Archive “${plan.title}”?`)) return
  try {
    await request(`/api/plans/${encodeURIComponent(plan.id)}/archive`, {
      method: 'POST',
    })
    toast(`Archived “${plan.title}”`)
    await loadPlans()
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function copyPath(plan) {
  try {
    const value = await request(`/api/plans/${encodeURIComponent(plan.id)}/copy-path`, {
      method: 'POST',
    })
    await navigator.clipboard.writeText(value.path)
    toast('Path copied')
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

async function openInEditor(plan) {
  try {
    await request(`/api/plans/${encodeURIComponent(plan.id)}/open-in-editor`, {
      method: 'POST',
    })
    toast('Opened in editor')
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

function planCard(plan, index) {
  const article = document.createElement('article')
  article.className = `card is-${plan.status}`

  const marker = document.createElement('span')
  marker.className = 'card-index'
  marker.textContent = String(index + 1).padStart(2, '0')
  article.append(marker)

  const link = document.createElement('a')
  link.href = plan.url
  const title = document.createElement('h3')
  title.className = 'plan-title'
  title.textContent = plan.title
  link.append(title)
  article.append(link)

  const metadata = document.createElement('div')
  metadata.className = 'plan-meta'
  metadata.append(statusBadge(plan.status))
  const date = document.createElement('time')
  date.className = 'plan-date'
  date.dateTime = plan.updated
  date.textContent = new Date(plan.updated).toLocaleString()
  metadata.append(date)
  for (const tag of plan.tags) {
    const tagElement = document.createElement('span')
    tagElement.className = 'plan-tag'
    tagElement.textContent = tag
    metadata.append(tagElement)
  }
  article.append(metadata)

  const actions = document.createElement('div')
  actions.className = 'plan-actions'
  const status = document.createElement('select')
  status.className = 'status-select'
  status.setAttribute('aria-label', `Status for ${plan.title}`)
  for (const value of ['active', 'completed', 'archived']) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    option.selected = value === plan.status
    status.append(option)
  }
  status.addEventListener('change', () => changeStatus(plan, status.value))
  actions.append(status)
  if (!hosted) {
    actions.append(
      button('Copy path', () => copyPath(plan)),
      button('Open in editor', () => openInEditor(plan)),
    )
    if (!plan.isArchived) actions.append(button('Archive', () => archivePlan(plan), 'btn danger'))
  }
  article.append(actions)
  return article
}

function render() {
  updateCounts()
  renderTags()
  for (const element of document.querySelectorAll('[data-status]')) {
    const selected = element.dataset.status === state.status
    element.classList.toggle('active', selected)
    element.setAttribute('aria-pressed', String(selected))
  }
  const plans = filteredPlans()
  const scope = [
    state.status === 'all' ? null : state.status,
    state.tag ? `tagged ${state.tag}` : null,
    state.query ? `matching “${state.query}”` : null,
  ].filter(Boolean).join(', ')
  summaryElement.textContent = `${plans.length} ${plans.length === 1 ? 'plan' : 'plans'}${scope ? ` · ${scope}` : ''}`
  listElement.replaceChildren()
  if (plans.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const heading = document.createElement('h3')
    heading.textContent = 'No plans found'
    const text = document.createElement('p')
    text.textContent = 'Try another search or filter.'
    empty.append(heading, text)
    listElement.append(empty)
    return
  }
  listElement.append(...plans.map((plan, index) => planCard(plan, index)))
}

async function loadPlans() {
  const pathname = state.query ? `/api/plans?q=${encodeURIComponent(state.query)}` : '/api/plans'
  const value = await request(pathname)
  state.plans = value.plans
  state.fingerprint = value.fingerprint
  warningElement.hidden = value.malformed.length === 0
  warningElement.textContent = value.malformed.length === 1
    ? 'One malformed Markdown file was skipped.'
    : `${value.malformed.length} malformed Markdown files were skipped.`
  render()
  if (hosted) {
    for (const footer of document.querySelectorAll('footer span:last-child')) {
      footer.textContent = 'Private · Owner access'
    }
  }
}

function connectEvents() {
  if (hosted) {
    liveDot.classList.remove('disconnected')
    liveLabel.textContent = 'Checking for updates'
    setInterval(() => loadPlans().catch(() => {}), 15000)
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
  events.addEventListener('connected', async event => {
    const value = JSON.parse(event.data)
    if (state.fingerprint && value.fingerprint !== state.fingerprint) {
      await loadPlans().catch(requestError => toast(requestError.message, 'error'))
    }
  })
  events.addEventListener('library', async event => {
    const value = JSON.parse(event.data)
    if (value.fingerprint !== state.fingerprint) {
      await loadPlans().catch(requestError => toast(requestError.message, 'error'))
    }
  })
}

for (const element of document.querySelectorAll('[data-status]')) {
  element.addEventListener('click', () => {
    state.status = element.dataset.status
    render()
  })
}

searchElement.addEventListener('input', () => {
  clearTimeout(state.searchTimer)
  state.searchTimer = setTimeout(async () => {
    state.query = searchElement.value.trim()
    await loadPlans().catch(requestError => toast(requestError.message, 'error'))
  }, 180)
})

filterToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open')
  filterToggle.setAttribute('aria-expanded', String(open))
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadPlans().catch(() => {})
})

async function start() {
  try {
    if (!hosted) {
      const session = await request('/_session')
      state.csrfToken = session.csrfToken
    }
    await loadPlans()
    connectEvents()
  } catch (requestError) {
    const failure = document.createElement('div')
    failure.className = 'empty-state'
    const heading = document.createElement('h3')
    heading.textContent = 'Library unavailable'
    const text = document.createElement('p')
    text.textContent = requestError.message
    failure.append(heading, text)
    listElement.replaceChildren(failure)
    toast(requestError.message, 'error')
  }
}

start()
