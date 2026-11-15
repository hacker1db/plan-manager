const state = {
  id: decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1)),
  plan: null,
  csrfToken: null,
  // Source editor state. `draft` is the source of truth while editing.
  editing: false,
  draft: '',
  dirty: false,
  saving: false,
  conflict: false,
  caretLine: 1,
  composerLine: null,
  composerQuote: null,
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
  if (!response.ok) {
    const failure = new Error(value.error || `Request failed with ${response.status}`)
    failure.status = response.status
    throw failure
  }
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
    const markdown = hosted
      ? await fetch(`/api/v1/plans/${encodeURIComponent(state.id)}/content`).then(async response => {
        if (!response.ok) throw new Error(`Request failed with ${response.status}`)
        return response.text()
      })
      : state.plan.body
    await navigator.clipboard.writeText(markdown)
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

// ---------------------------------------------------------------------------
// Review comments
//
// A comment is an inline HTML comment at the end of the line it refers to:
//   - [ ] Ship it <!-- plan-comment: split into two steps -->
// Obsidian hides these, agents reading the file see them, and the server strips
// them before rendering. Lines inside fenced code get a marker line after the
// fence instead, so the code itself is never changed.
// ---------------------------------------------------------------------------

const COMMENT_MARKER = /[ \t]*<!--\s*plan-comment:(.*?)-->/g
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/
// Text highlighted in the preview is kept with the comment: [re: "…"] comment
const QUOTE_PREFIX = /^\[re: "(.*)"\]\s*/

// Returns, per line, the index of the fenced block it belongs to, or -1.
function fenceBlocks(lines) {
  const blocks = new Array(lines.length).fill(-1)
  let fence = ''
  let block = -1
  lines.forEach((line, index) => {
    if (fence) {
      blocks[index] = block
      const trimmed = line.trimStart()
      if (trimmed.startsWith(fence) && trimmed.replace(new RegExp(`^\\${fence[0]}+`), '').trim() === '') fence = ''
      return
    }
    const match = line.match(FENCE_OPEN)
    if (match) {
      fence = match[1]
      block += 1
      blocks[index] = block
    }
  })
  return blocks
}

function parseComments(text) {
  const lines = text.split('\n')
  const blocks = fenceBlocks(lines)
  const comments = []
  lines.forEach((line, index) => {
    if (blocks[index] !== -1) return
    let occurrence = 0
    for (const match of line.matchAll(COMMENT_MARKER)) {
      const raw = match[1].trim()
      const quoted = raw.match(QUOTE_PREFIX)
      comments.push({
        line: index + 1,
        occurrence,
        text: quoted ? raw.slice(quoted[0].length) : raw,
        quote: quoted ? quoted[1] : null,
      })
      occurrence += 1
    }
  })
  return comments
}

function lineSnippet(lines, lineNumber) {
  const raw = (lines[lineNumber - 1] ?? '').replace(COMMENT_MARKER, '').trim()
  if (!raw) return '(own line)'
  return raw.length > 90 ? `${raw.slice(0, 89)}…` : raw
}

// Keeps comment text on one line and unable to close the HTML comment early.
function commentMarker(text) {
  const safe = text.replace(/\s+/g, ' ').trim().replaceAll('--', '–')
  return `<!-- plan-comment: ${safe} -->`
}

function quotePrefix(quote) {
  const clean = (quote ?? '').replace(/\s+/g, ' ').replaceAll('"', "'").trim()
  if (!clean) return ''
  return `[re: "${clean.length > 120 ? `${clean.slice(0, 119)}…` : clean}"] `
}

// Returns the new text and the line that now carries the comment. `quote` is
// the text the comment is about, when the user highlighted some.
function insertComment(text, lineNumber, comment, quote = null) {
  const lines = text.split('\n')
  const blocks = fenceBlocks(lines)
  const index = Math.min(Math.max(lineNumber, 1), lines.length) - 1
  if (quote) comment = quotePrefix(quote) + comment
  if (blocks[index] !== -1) {
    let end = index
    while (end + 1 < lines.length && blocks[end + 1] === blocks[index]) end += 1
    const code = lines[index].trim().slice(0, 60)
    const prefix = !quote && code ? `[code: ${code}] ` : ''
    lines.splice(end + 1, 0, commentMarker(prefix + comment))
    return { text: lines.join('\n'), line: end + 2 }
  }
  const current = lines[index].replace(/[ \t]+$/, '')
  lines[index] = `${current}${current ? ' ' : ''}${commentMarker(comment)}`
  return { text: lines.join('\n'), line: index + 1 }
}

function removeComment(text, comment) {
  const lines = text.split('\n')
  const index = comment.line - 1
  let seen = -1
  const next = lines[index].replace(COMMENT_MARKER, match => {
    seen += 1
    return seen === comment.occurrence ? '' : match
  }).replace(/[ \t]+$/, '')
  // A marker line that was added after a code fence goes away entirely.
  const blocks = fenceBlocks(lines)
  if (next === '' && index > 0 && blocks[index - 1] !== -1) lines.splice(index, 1)
  else lines[index] = next
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Source editor
// ---------------------------------------------------------------------------

const ui = {}

function lineOfOffset(text, offset) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

function offsetOfLine(text, lineNumber) {
  let offset = 0
  for (let line = 1; line < lineNumber; line += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return offset
}

function setHash() {
  const hash = state.editing ? '#edit' : ''
  if (window.location.hash !== hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
  }
}

function setDirty(dirty) {
  state.dirty = dirty
  updateEditorStatus()
}

function updateEditorStatus() {
  if (!ui.status) return
  const parts = [`Ln ${state.caretLine}`]
  if (state.saving) parts.push('Saving…')
  else if (state.dirty) parts.push('Unsaved changes')
  else parts.push('Saved')
  ui.status.textContent = parts.join(' · ')
  ui.status.classList.toggle('is-dirty', state.dirty)
  ui.save.disabled = state.saving || !state.dirty
  ui.conflict.hidden = !state.conflict
}

function renderGutter() {
  const lines = state.draft.split('\n')
  const commented = new Set(parseComments(state.draft).map(comment => comment.line))
  const fragment = document.createDocumentFragment()
  for (let line = 1; line <= lines.length; line += 1) {
    const number = document.createElement('button')
    number.type = 'button'
    number.className = 'gutter-line'
    if (commented.has(line)) number.classList.add('has-comment')
    if (line === state.caretLine) number.classList.add('is-current')
    number.textContent = String(line)
    number.dataset.line = String(line)
    number.title = `Comment on line ${line}`
    number.setAttribute('aria-label', `Comment on line ${line}`)
    fragment.append(number)
  }
  ui.gutter.replaceChildren(fragment)
  ui.gutter.scrollTop = ui.textarea.scrollTop
}

function renderCommentList() {
  const lines = state.draft.split('\n')
  const comments = parseComments(state.draft)
  ui.count.textContent = String(comments.length)
  ui.list.replaceChildren()
  if (comments.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'comment-empty'
    empty.textContent = 'No comments yet. Click a line number to leave one.'
    ui.list.append(empty)
    return
  }
  for (const comment of comments) {
    ui.list.append(commentItem(comment, lines, {
      jumpTitle: `Go to line ${comment.line}`,
      onJump: () => focusLine(comment.line),
      onResolve: () => {
        updateDraft(removeComment(state.draft, comment))
        toast('Comment resolved — save to keep it')
      },
    }))
  }
}

function renderComposer() {
  const open = state.composerLine !== null
  ui.composer.hidden = !open
  if (!open) return
  const lines = state.draft.split('\n')
  ui.composerLabel.textContent = `Line ${state.composerLine}`
  ui.composerSnippet.textContent = state.composerQuote ? `“${state.composerQuote}”` : lineSnippet(lines, state.composerLine)
}

function updateDraft(text, { keepSelection = true } = {}) {
  const { selectionStart, selectionEnd, scrollTop } = ui.textarea
  state.draft = text
  ui.textarea.value = text
  if (keepSelection) {
    ui.textarea.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length))
    ui.textarea.scrollTop = scrollTop
  }
  setDirty(text !== state.plan.body)
  renderGutter()
  renderCommentList()
  renderComposer()
}

function focusLine(lineNumber) {
  const lines = state.draft.split('\n')
  const line = Math.min(Math.max(lineNumber, 1), lines.length)
  // A collapsed caret, not a selection: typing must never replace the line.
  const start = offsetOfLine(state.draft, line)
  ui.textarea.focus({ preventScroll: true })
  ui.textarea.setSelectionRange(start, start)
  const lineHeight = parseFloat(getComputedStyle(ui.textarea).lineHeight) || 20
  ui.textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - ui.textarea.clientHeight / 3)
  ui.gutter.scrollTop = ui.textarea.scrollTop
  trackCaret()
}

function trackCaret() {
  const line = lineOfOffset(ui.textarea.value, ui.textarea.selectionStart)
  if (line === state.caretLine) return
  ui.gutter.querySelector('.is-current')?.classList.remove('is-current')
  ui.gutter.querySelector(`[data-line="${line}"]`)?.classList.add('is-current')
  state.caretLine = line
  updateEditorStatus()
}

function openComposer(lineNumber) {
  const { selectionStart, selectionEnd, value } = ui.textarea
  const selected = value.slice(selectionStart, selectionEnd)
  const onLine = lineOfOffset(value, selectionStart) === lineNumber
  state.composerQuote = onLine && selected && !selected.includes('\n') ? selected.replace(COMMENT_MARKER, '').trim() : null
  state.composerLine = lineNumber
  renderComposer()
  ui.composerInput.value = ''
  ui.composerInput.focus()
}

function closeComposer() {
  state.composerLine = null
  renderComposer()
}

function submitComment() {
  const text = ui.composerInput.value.trim()
  if (!text || state.composerLine === null) return
  const result = insertComment(state.draft, state.composerLine, text, state.composerQuote)
  closeComposer()
  updateDraft(result.text)
  focusLine(result.line)
  toast(`Comment added to line ${result.line} — save to keep it`)
}

async function saveDraft() {
  if (state.saving || !state.dirty) return
  state.saving = true
  updateEditorStatus()
  try {
    const value = await mutate('body', {
      body: JSON.stringify({ body: state.draft, revision: state.plan.revision }),
    })
    state.plan.revision = value.revision
    state.dirty = false
    state.saving = false
    await loadPlan()
    toast('Plan saved')
  } catch (requestError) {
    state.saving = false
    if (requestError.status === 409) state.conflict = true
    updateEditorStatus()
    toast(requestError.message, 'error')
  }
}

function enterEditor(lineNumber) {
  state.editing = true
  state.draft = state.plan.body
  state.dirty = false
  state.conflict = false
  state.composerLine = null
  setHash()
  render()
  if (lineNumber) focusLine(lineNumber)
  else ui.textarea.focus({ preventScroll: true })
}

function leaveEditor() {
  if (state.dirty && !window.confirm('Discard unsaved changes to this plan?')) return
  state.editing = false
  state.dirty = false
  state.conflict = false
  state.composerLine = null
  setHash()
  render()
}

async function reloadLatest() {
  state.dirty = false
  state.conflict = false
  await loadPlan()
  toast('Loaded the latest version from disk')
}

async function copyDraft() {
  try {
    await navigator.clipboard.writeText(state.draft)
    toast('Your draft was copied')
  } catch {
    toast('Could not copy the draft', 'error')
  }
}

function editorPanel() {
  const section = document.createElement('section')
  section.className = 'editor'
  section.setAttribute('aria-label', 'Plan source editor')

  const bar = document.createElement('div')
  bar.className = 'editor-bar'
  const title = document.createElement('span')
  title.className = 'editor-title'
  title.textContent = 'Markdown source'
  ui.status = document.createElement('span')
  ui.status.className = 'editor-status'
  ui.status.setAttribute('aria-live', 'polite')
  const spacer = document.createElement('span')
  spacer.className = 'editor-spacer'
  const comment = button('Comment on line', () => openComposer(state.caretLine))
  comment.title = 'Comment on the line with the cursor (⌘/Ctrl+Shift+M)'
  ui.save = button('Save', saveDraft, 'btn primary')
  ui.save.title = 'Save (⌘/Ctrl+S)'
  bar.append(title, ui.status, spacer, comment, ui.save, button('Done', leaveEditor))

  ui.conflict = document.createElement('div')
  ui.conflict.className = 'editor-conflict'
  ui.conflict.setAttribute('role', 'alert')
  const conflictText = document.createElement('span')
  conflictText.textContent = 'This plan changed on disk after you started editing. Saving is blocked until you reload.'
  ui.conflict.append(conflictText, button('Copy my draft', copyDraft), button('Reload latest', reloadLatest, 'btn danger'))

  const grid = document.createElement('div')
  grid.className = 'editor-grid'

  const source = document.createElement('div')
  source.className = 'editor-source'
  ui.gutter = document.createElement('div')
  ui.gutter.className = 'editor-gutter'
  ui.gutter.addEventListener('click', event => {
    const target = event.target.closest('[data-line]')
    if (target) openComposer(Number(target.dataset.line))
  })
  ui.textarea = document.createElement('textarea')
  ui.textarea.className = 'editor-text'
  ui.textarea.spellcheck = false
  ui.textarea.wrap = 'off'
  ui.textarea.setAttribute('aria-label', 'Plan Markdown')
  ui.textarea.value = state.draft
  ui.textarea.addEventListener('input', () => {
    state.draft = ui.textarea.value
    setDirty(state.draft !== state.plan.body)
    trackCaret()
    renderGutter()
    renderCommentList()
    renderComposer()
  })
  ui.textarea.addEventListener('scroll', () => { ui.gutter.scrollTop = ui.textarea.scrollTop })
  for (const kind of ['click', 'keyup', 'select']) ui.textarea.addEventListener(kind, trackCaret)
  source.append(ui.gutter, ui.textarea)

  const aside = document.createElement('aside')
  aside.className = 'editor-comments'
  const heading = document.createElement('h2')
  heading.textContent = 'Comments '
  ui.count = document.createElement('span')
  ui.count.className = 'comment-count'
  heading.append(ui.count)

  ui.composer = document.createElement('form')
  ui.composer.className = 'comment-composer'
  ui.composerLabel = document.createElement('strong')
  ui.composerSnippet = document.createElement('span')
  ui.composerSnippet.className = 'comment-snippet'
  const target = document.createElement('div')
  target.className = 'comment-head'
  target.append(ui.composerLabel, ui.composerSnippet)
  ui.composerInput = document.createElement('textarea')
  ui.composerInput.className = 'comment-input'
  ui.composerInput.rows = 3
  ui.composerInput.placeholder = 'What should change here?'
  ui.composerInput.setAttribute('aria-label', 'Comment text')
  ui.composerInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submitComment()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeComposer()
      ui.textarea.focus()
    }
  })
  const add = document.createElement('button')
  add.type = 'submit'
  add.className = 'btn primary'
  add.textContent = 'Add comment'
  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  actions.append(add, button('Cancel', closeComposer))
  ui.composer.append(target, ui.composerInput, actions)
  ui.composer.addEventListener('submit', event => {
    event.preventDefault()
    submitComment()
  })

  ui.list = document.createElement('ol')
  ui.list.className = 'comment-list'

  const hint = document.createElement('p')
  hint.className = 'comment-hint'
  hint.append('Click a line number to comment. Comments are stored in the plan as ')
  const code = document.createElement('code')
  code.textContent = '<!-- plan-comment: … -->'
  hint.append(code, ' markers — hidden in Obsidian, visible to agents.')

  aside.append(heading, ui.composer, ui.list, hint)
  grid.append(source, aside)
  section.append(bar, ui.conflict, grid)

  renderGutter()
  renderCommentList()
  renderComposer()
  updateEditorStatus()
  return section
}

// A comment card, shared by the editor sidebar and the preview list.
function commentItem(comment, lines, { onJump, onResolve, jumpTitle }) {
  const item = document.createElement('li')
  item.className = 'comment-item'
  item.dataset.line = String(comment.line)
  const head = document.createElement('div')
  head.className = 'comment-head'
  const jump = button(`L${comment.line}`, onJump, 'comment-line')
  jump.title = jumpTitle
  const snippet = document.createElement('span')
  snippet.className = 'comment-snippet'
  snippet.textContent = comment.quote ? `“${comment.quote}”` : lineSnippet(lines, comment.line)
  head.append(jump, snippet)
  const text = document.createElement('p')
  text.className = 'comment-text'
  text.textContent = comment.text
  item.append(head, text, button('Resolve', onResolve, 'btn comment-resolve'))
  return item
}

// Preview mode: comments listed above the rendered plan. Resolving here saves
// immediately; the line badge opens the editor at that line.
function commentSummary(plan) {
  const comments = parseComments(plan.body)
  if (comments.length === 0) return null
  const lines = plan.body.split('\n')
  const section = document.createElement('section')
  section.className = 'review-comments'
  const heading = document.createElement('h2')
  heading.textContent = `Review comments (${comments.length})`
  const list = document.createElement('ol')
  list.className = 'comment-list'
  for (const comment of comments) {
    list.append(commentItem(comment, lines, {
      jumpTitle: `Edit at line ${comment.line}`,
      onJump: () => enterEditor(comment.line),
      onResolve: () => saveBodyNow(removeComment(plan.body, comment), 'Comment resolved'),
    }))
  }
  section.append(heading, list)
  return section
}

// Saves a body change made outside the editor (preview comments).
async function saveBodyNow(body, message) {
  try {
    await mutate('body', { body: JSON.stringify({ body, revision: state.plan.revision }) })
    await loadPlan()
    toast(message)
    return true
  } catch (requestError) {
    if (requestError.status === 409) {
      await loadPlan().catch(() => {})
      toast('The plan changed on disk; reloaded. Please try again.', 'error')
    } else {
      toast(requestError.message, 'error')
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Highlight-to-comment in the rendered preview
//
// The rendered HTML has no source positions, so the highlighted text is found
// in a plain-text projection of the Markdown (syntax stripped, whitespace
// collapsed) that remembers which source line each character came from.
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return value
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/—/g, '---').replace(/–/g, '--')
    .replace(/\s+/g, ' ')
}

function plainProjection(body) {
  const lines = body.split('\n')
  const blocks = fenceBlocks(lines)
  let plain = ''
  const lineAt = []
  lines.forEach((line, index) => {
    let text = line.replace(COMMENT_MARKER, '')
    if (blocks[index] !== -1) {
      if (/^[ \t]*(`{3,}|~{3,})/.test(text)) text = ''
    } else {
      text = text
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^(\s*>)+\s?/, '')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|~~|[*`]/g, '')
        .replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' ')
    }
    text = normalizeText(text).trim()
    if (!text) return
    if (plain) {
      plain += ' '
      lineAt.push(index + 1)
    }
    for (let i = 0; i < text.length; i += 1) lineAt.push(index + 1)
    plain += text
  })
  return { plain, lineAt }
}

function nthIndex(haystack, needle, n) {
  let at = -1
  for (let i = 0; i <= n; i += 1) {
    at = haystack.indexOf(needle, at + 1)
    if (at === -1) return -1
  }
  return at
}

// Maps a selection in the rendered article to a 1-based source line.
function sourceLineForSelection(article, range, selected) {
  const { plain, lineAt } = plainProjection(state.plan.body)
  const before = document.createRange()
  before.setStart(article, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const prefix = normalizeText(before.toString())
  const candidates = [selected, selected.slice(0, 40), selected.split(' ').slice(0, 3).join(' ')]
  for (const raw of candidates) {
    const needle = raw.trim()
    if (!needle) continue
    const occurrence = prefix.split(needle).length - 1
    let at = nthIndex(plain, needle, occurrence)
    if (at === -1) at = plain.indexOf(needle)
    if (at !== -1) return lineAt[at]
  }
  return null
}

const popover = { element: null, input: null, line: null, quote: '', range: null }

function closePopover() {
  popover.element?.remove()
  popover.element = null
}

// Measures the selection now, so scrolling since it was made doesn't matter.
function placePopover() {
  const rect = popover.range.getBoundingClientRect()
  const element = popover.element
  const width = element.offsetWidth
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8)
  // Page coordinates, so the popup stays with the text when scrolling.
  let top = rect.bottom + 8
  if (top + element.offsetHeight > window.innerHeight - 8 && rect.top - element.offsetHeight - 8 > 0) {
    top = rect.top - element.offsetHeight - 8
  }
  element.style.left = `${left + window.scrollX}px`
  element.style.top = `${top + window.scrollY}px`
}

function expandPopover() {
  const element = popover.element
  element.replaceChildren()
  element.classList.add('is-open')
  const label = document.createElement('div')
  label.className = 'comment-head'
  const line = document.createElement('strong')
  line.textContent = `Line ${popover.line}`
  const quote = document.createElement('span')
  quote.className = 'comment-snippet'
  quote.textContent = `“${popover.quote}”`
  label.append(line, quote)
  popover.input = document.createElement('textarea')
  popover.input.className = 'comment-input'
  popover.input.rows = 3
  popover.input.placeholder = 'What should change here?'
  popover.input.setAttribute('aria-label', 'Comment text')
  const submit = async () => {
    const text = popover.input.value.trim()
    if (!text) return
    const result = insertComment(state.plan.body, popover.line, text, popover.quote)
    closePopover()
    window.getSelection()?.removeAllRanges()
    await saveBodyNow(result.text, `Comment added to line ${result.line}`)
  }
  popover.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closePopover()
    }
  })
  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  actions.append(button('Comment', submit, 'btn primary'), button('Cancel', closePopover))
  const hint = document.createElement('span')
  hint.className = 'comment-hint'
  hint.textContent = '⌘/Ctrl+Enter to save'
  actions.append(hint)
  element.append(label, popover.input, actions)
  placePopover()
  popover.input.focus({ preventScroll: true })
}

function showSelectionPopover(article) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (!article.contains(range.commonAncestorContainer)) return
  const selected = normalizeText(selection.toString()).trim()
  if (!selected) return
  const line = sourceLineForSelection(article, range, selected)
  closePopover()
  const element = document.createElement('div')
  element.className = 'selection-popover'
  element.setAttribute('role', 'dialog')
  element.setAttribute('aria-label', 'Comment on selection')
  popover.element = element
  popover.line = line
  popover.quote = selected
  popover.range = range.cloneRange()
  document.body.append(element)
  if (line === null) {
    const note = document.createElement('span')
    note.className = 'comment-hint'
    note.textContent = 'Could not find this text in the source.'
    element.append(note, button('Open editor', () => { closePopover(); enterEditor() }))
    placePopover()
    return
  }
  const trigger = button('💬 Comment', () => expandPopover(), 'btn primary')
  trigger.title = `Comment on line ${line}`
  element.append(trigger)
  placePopover()
}

function enableSelectionComments(article) {
  const check = event => {
    if (popover.element?.contains(event.target)) return
    // Let the browser finish updating the selection first.
    setTimeout(() => showSelectionPopover(article), 0)
  }
  article.addEventListener('mouseup', check)
  article.addEventListener('keyup', event => { if (event.shiftKey) check(event) })
}

document.addEventListener('mousedown', event => {
  if (popover.element && !popover.element.contains(event.target)) closePopover()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && popover.element) closePopover()
})
window.addEventListener('resize', closePopover)

// A marker on its own line right after a code fence refers to that block.
function fencedBefore(lineNumber) {
  const lines = state.plan.body.split('\n')
  return lineNumber >= 2 && fenceBlocks(lines)[lineNumber - 2] !== -1
}

// Marks commented text in the preview; clicking a mark shows its comment.
function highlightQuotes(article, comments) {
  for (const comment of comments) {
    if (!comment.quote || comment.quote.endsWith('…')) continue
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // One-for-one character mapping keeps offsets valid in the text node.
      const at = node.data.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s/g, ' ').indexOf(comment.quote)
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + comment.quote.length)
      // Repeated text: highlight the occurrence that came from the comment's line.
      const line = sourceLineForSelection(article, range, comment.quote)
      if (line !== comment.line && !(line < comment.line && fencedBefore(comment.line))) continue
      const mark = document.createElement('mark')
      mark.className = 'comment-mark'
      mark.title = comment.text
      mark.addEventListener('click', () => {
        const card = document.querySelector(`.review-comments .comment-item[data-line="${comment.line}"]`)
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card?.classList.add('is-flash')
        setTimeout(() => card?.classList.remove('is-flash'), 1200)
      })
      range.surroundContents(mark)
      break
    }
  }
}

document.addEventListener('keydown', event => {
  if (!state.editing || !(event.metaKey || event.ctrlKey)) return
  const key = event.key.toLowerCase()
  if (key === 's') {
    event.preventDefault()
    saveDraft()
  } else if (key === 'm' && event.shiftKey) {
    event.preventDefault()
    openComposer(state.caretLine)
  }
})

window.addEventListener('beforeunload', event => {
  if (state.editing && state.dirty) event.preventDefault()
})

// ---------------------------------------------------------------------------
// Start a T3 Code thread for this plan
// ---------------------------------------------------------------------------

const LAST_T3_PROJECT = 'plan-manager:last-t3-project'

function storedProject() {
  try { return window.localStorage.getItem(LAST_T3_PROJECT) } catch { return null }
}

function rememberProject(value) {
  try { window.localStorage.setItem(LAST_T3_PROJECT, value) } catch { /* private mode */ }
}

function t3Message(plan) {
  return [
    `Start working on the plan "${plan.title}" (Plan Manager id: ${plan.id}).`,
    '',
    `Read the full plan first with \`plan show ${plan.id}\` (file: ${plan.filePath}).`,
    'Address any `<!-- plan-comment: … -->` markers in it as review feedback before starting the work.',
    'Then work through the unchecked tasks in order, checking each one off in the plan file as you finish it, and tell me if anything in the plan is unclear or wrong.',
  ].join('\n')
}

function field(labelText, control, hint) {
  const label = document.createElement('label')
  label.className = 't3-field'
  const name = document.createElement('span')
  name.textContent = labelText
  label.append(name, control)
  if (hint) {
    const note = document.createElement('small')
    note.textContent = hint
    label.append(note)
  }
  return label
}

async function openT3Dialog() {
  const plan = state.plan
  const dialog = document.createElement('dialog')
  dialog.className = 't3-dialog'
  dialog.setAttribute('aria-label', 'Start in T3 Code')
  const form = document.createElement('form')
  form.method = 'dialog'
  const heading = document.createElement('h2')
  heading.textContent = 'Start in a new T3 thread'
  const status = document.createElement('p')
  status.className = 't3-status'
  status.textContent = 'Loading T3 projects…'
  form.append(heading, status)
  dialog.append(form)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()

  let info
  try {
    const query = plan.source ? `?source=${encodeURIComponent(plan.source)}` : ''
    info = await request(`/api/t3/projects${query}`)
  } catch (requestError) {
    status.textContent = requestError.message
    return
  }
  if (!info.available) {
    status.textContent = 'The T3 Code CLI (t3) was not found on this machine.'
    form.append(button('Close', () => dialog.close()))
    return
  }

  const project = document.createElement('select')
  for (const item of info.projects) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = `${item.title} — ${item.root.replace(/^\/Users\/[^/]+/, '~')}`
    option.dataset.base = item.baseBranch
    project.append(option)
  }
  const other = document.createElement('option')
  other.value = '__folder__'
  other.textContent = 'Another folder…'
  project.append(other)
  const remembered = storedProject()
  const known = value => info.projects.some(item => item.id === value)
  project.value = info.suggested || (known(remembered) ? remembered : info.projects[0]?.id ?? '__folder__')

  const folder = document.createElement('input')
  folder.type = 'text'
  folder.placeholder = '/Users/you/Developer/repo'
  const folderField = field('Folder', folder, 'A folder T3 doesn’t know yet is added as a new T3 project first.')

  const title = document.createElement('input')
  title.type = 'text'
  title.value = plan.title
  title.maxLength = 200

  const message = document.createElement('textarea')
  message.rows = 7
  message.value = t3Message(plan)

  const worktree = document.createElement('input')
  worktree.type = 'checkbox'
  worktree.checked = true
  const base = document.createElement('input')
  base.type = 'text'
  base.className = 't3-base'
  const worktreeRow = document.createElement('label')
  worktreeRow.className = 't3-check'
  worktreeRow.append(worktree, ' Run in a new git worktree from ', base)

  const open = document.createElement('input')
  open.type = 'checkbox'
  open.checked = true
  const openRow = document.createElement('label')
  openRow.className = 't3-check'
  openRow.append(open, ' Open T3 Code afterwards')

  const sync = () => {
    const custom = project.value === '__folder__'
    folderField.hidden = !custom
    base.value = custom ? 'HEAD' : project.selectedOptions[0]?.dataset.base || 'HEAD'
  }
  project.addEventListener('change', sync)
  worktree.addEventListener('change', () => { base.disabled = !worktree.checked })
  sync()

  const start = document.createElement('button')
  start.type = 'submit'
  start.className = 'btn primary'
  start.textContent = 'Start thread'
  const actions = document.createElement('div')
  actions.className = 'comment-actions'
  actions.append(start, button('Cancel', () => dialog.close()))

  status.textContent = info.suggested
    ? 'Project matched from the plan’s source path.'
    : info.projects.length ? '' : 'No T3 projects found; enter a folder that is one.'
  form.append(
    field('Project', project),
    folderField,
    field('Thread title', title),
    field('Message to the agent', message, 'Sent as the first message of the new thread.'),
    worktreeRow,
    openRow,
    actions,
  )
  project.focus()

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const target = project.value === '__folder__' ? folder.value.trim() : project.value
    if (!target) {
      status.textContent = 'Choose a project or enter a folder.'
      return
    }
    start.disabled = true
    status.textContent = 'Starting thread…'
    try {
      const value = await mutate('t3', {
        body: JSON.stringify({
          project: target,
          title: title.value,
          message: message.value,
          worktree: worktree.checked ? base.value.trim() : '',
          open: open.checked,
        }),
      })
      rememberProject(target)
      dialog.close()
      const added = value.registered ? ' (folder added as a T3 project)' : ''
      toast(value.threadId ? `T3 thread started: ${value.threadId}${added}` : `T3 thread started${added}`)
    } catch (requestError) {
      start.disabled = false
      status.textContent = requestError.message
    }
  })
}

// ---------------------------------------------------------------------------
// Keyboard navigation: h / l = previous / next plan (library order),
// space / shift+space = next / previous section of the page.
// ---------------------------------------------------------------------------

let planOrder = null

async function neighbourPlan(step) {
  if (!planOrder) {
    const value = await request('/api/plans')
    const current = value.plans.find(plan => plan.id === state.id)
    // Stay within the same shelf: archived plans step through archived ones.
    planOrder = value.plans.filter(plan => plan.isArchived === Boolean(current?.isArchived))
  }
  const index = planOrder.findIndex(plan => plan.id === state.id)
  return index === -1 ? null : planOrder[index + step] ?? null
}

async function goToPlan(step) {
  if (state.editing && state.dirty && !window.confirm('Discard unsaved changes to this plan?')) return
  try {
    const next = await neighbourPlan(step)
    if (!next) {
      toast(step > 0 ? 'This is the last plan' : 'This is the first plan')
      return
    }
    state.dirty = false
    window.location.href = next.url
  } catch (requestError) {
    toast(requestError.message, 'error')
  }
}

function sectionTargets() {
  const targets = [
    detailElement.querySelector('.detail-hero'),
    detailElement.querySelector('.review-comments'),
    detailElement.querySelector('.document'),
    ...detailElement.querySelectorAll('.markdown-body :is(h1, h2, h3)'),
  ].filter(Boolean)
  return targets
    .map(element => ({ element, top: element.getBoundingClientRect().top + window.scrollY }))
    .sort((a, b) => a.top - b.top)
}

function jumpSection(step) {
  const offset = 16
  const position = window.scrollY + offset + 1
  const targets = sectionTargets()
  const target = step > 0
    ? targets.find(item => item.top > position)
    : [...targets].reverse().find(item => item.top < position - 2)
  if (!target) {
    window.scrollTo({ top: step > 0 ? document.documentElement.scrollHeight : 0, behavior: 'smooth' })
    return
  }
  window.scrollTo({ top: Math.max(0, target.top - offset), behavior: 'smooth' })
}

function typingTarget(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))
}

document.addEventListener('keydown', event => {
  if (hosted || state.editing || !state.plan) return
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
  if (typingTarget(event.target) || document.querySelector('dialog[open]') || popover.element) return
  if (event.key === 'h') {
    event.preventDefault()
    goToPlan(-1)
  } else if (event.key === 'l') {
    event.preventDefault()
    goToPlan(1)
  } else if (event.key === ' ') {
    event.preventDefault()
    jumpSection(event.shiftKey ? -1 : 1)
  }
})

// Called when the file changes on disk. Never discards unsaved edits.
function remoteChanged() {
  if (state.editing) {
    if (state.dirty) {
      state.conflict = true
      updateEditorStatus()
      return
    }
    loadPlan().catch(() => {})
    return
  }
  window.location.reload()
}

function render() {
  const plan = state.plan
  document.title = `${plan.title} · Plan Library`
  closePopover()
  const previous = state.editing && ui.textarea?.isConnected
    ? { start: ui.textarea.selectionStart, end: ui.textarea.selectionEnd, scroll: ui.textarea.scrollTop, focused: document.activeElement === ui.textarea }
    : null
  if (state.editing && !state.dirty) state.draft = plan.body
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
  const edit = state.editing
    ? button('Preview', leaveEditor, 'btn')
    : button('Edit & comment', () => enterEditor(), 'btn primary')
  const t3 = button('▶ Start in T3', openT3Dialog)
  t3.title = 'Start a new T3 Code thread that works on this plan'
  actions.append(
    status,
    edit,
    t3,
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
    highlightQuotes(body, parseComments(plan.body))
    enableSelectionComments(body)
  } else {
    body.className = 'markdown-fallback'
    body.textContent = plan.body
  }
  sheet.append(body)
  if (state.editing) {
    detailElement.append(header, metadata, actions, editorPanel())
    if (previous) {
      ui.textarea.setSelectionRange(previous.start, previous.end)
      ui.textarea.scrollTop = previous.scroll
      ui.gutter.scrollTop = previous.scroll
      if (previous.focused) ui.textarea.focus({ preventScroll: true })
      trackCaret()
    }
    return
  }
  const summary = commentSummary(plan)
  detailElement.append(header, metadata, actions, ...(summary ? [summary] : []), sheet)
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
    if (latest.revision !== state.plan.revision) remoteChanged()
  } catch {
    if (!(state.editing && state.dirty)) window.location.reload()
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
      if (state.editing) remoteChanged()
      else window.location.reload()
    }
  })
  events.addEventListener('library', event => {
    const value = JSON.parse(event.data)
    if (value.removed.includes(state.id) && !(state.editing && state.dirty)) window.location.reload()
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconcileRevision()
})

async function start() {
  try {
    if (hosted) {
      state.plan = { revision: detailElement.dataset.revision }
      detailElement.querySelector('[data-copy-source]')?.addEventListener('click', copyMarkdown)
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
    if (window.location.hash === '#edit') enterEditor()
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
