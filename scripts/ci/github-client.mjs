// Minimal GitHub REST client for trusted workflows. Uses the workflow's GITHUB_TOKEN with the
// permissions the job grants; never logs request or response bodies.
export function createGitHubClient({ token, repository, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required')
  async function request(method, path, body) {
    const response = await fetchImpl(new URL(path.replace('{repo}', repository), apiBase), {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`GitHub API ${method} ${new URL(path.replace('{repo}', repository), apiBase).pathname} failed with HTTP ${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  }
  return { request, repository }
}
