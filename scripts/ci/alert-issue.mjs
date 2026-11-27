// Deduplicated alert issues: one open issue per alert title. A failing check creates the issue or
// rewrites its body; a passing check comments and closes it. Bodies must contain names and IDs
// only, never variable values.
async function findOpen(github, title) {
  for (let page = 1; page <= 5; page++) {
    const issues = await github.request('GET', `/repos/{repo}/issues?state=open&per_page=100&page=${page}`)
    const match = issues.find(issue => !issue.pull_request && issue.title === title)
    if (match) return match
    if (issues.length < 100) return null
  }
  return null
}

// Returns 'created' | 'updated' | 'closed' | 'none'.
export async function reconcileAlert(github, { title, failing, body }) {
  const open = await findOpen(github, title)
  if (failing) {
    if (open) {
      await github.request('PATCH', `/repos/{repo}/issues/${open.number}`, { body })
      return 'updated'
    }
    await github.request('POST', '/repos/{repo}/issues', { title, body })
    return 'created'
  }
  if (!open) return 'none'
  await github.request('POST', `/repos/{repo}/issues/${open.number}/comments`, { body: 'Resolved: the latest check passed.' })
  await github.request('PATCH', `/repos/{repo}/issues/${open.number}`, { state: 'closed', state_reason: 'completed' })
  return 'closed'
}
