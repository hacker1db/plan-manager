// Minimal Vercel REST client for the trusted workflows (drift audit, release, preview smoke).
// It never requests decrypted values: environment listings drop `value` (and any other value-like
// field) before anything else sees them. Requests and responses are never logged.
//
// `teamId` is optional: on a Hobby account (assumption A1) projects belong to the personal scope
// and no team parameter is sent.
const API = 'https://api.vercel.com'

export class VercelApiError extends Error {
  constructor(method, path, status) {
    super(`Vercel API ${method} ${path} failed with HTTP ${status}`)
    this.name = 'VercelApiError'
    this.status = status
  }
}

// Keeps only metadata from an environment variable record. Exported for tests.
export function envMetadata(record) {
  const target = Array.isArray(record?.target) ? record.target : record?.target ? [record.target] : []
  return { key: String(record?.key ?? ''), target, type: String(record?.type ?? ''), id: String(record?.id ?? '') }
}

export function createVercelClient({ token, teamId, fetchImpl = fetch, apiBase = API }) {
  if (!token) throw new Error('VERCEL_TOKEN is not set for this workflow environment')
  async function request(method, path, query = {}) {
    const url = new URL(path, apiBase)
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    if (teamId) url.searchParams.set('teamId', teamId)
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
    if (!response.ok) throw new VercelApiError(method, url.pathname, response.status)
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  }
  return {
    request,
    async listEnv(projectId) {
      // No `decrypt` parameter: Vercel returns no plaintext for encrypted or sensitive types, and the
      // value of plain types is dropped here immediately.
      const body = await request('GET', `/v10/projects/${encodeURIComponent(projectId)}/env`)
      const records = Array.isArray(body?.envs) ? body.envs : []
      return records.map(envMetadata)
    },
    getProject: projectId => request('GET', `/v9/projects/${encodeURIComponent(projectId)}`),
    // Pages through every deployment (newest first) until Vercel reports no further page. Fails
    // closed rather than returning a partial list.
    async listDeployments(projectId, { since, target, limit = 100, maxPages = 50 } = {}) {
      const deployments = []
      let until
      for (let page = 0; page < maxPages; page++) {
        const body = await request('GET', '/v6/deployments', { projectId, since, target, limit, until })
        if (Array.isArray(body?.deployments)) deployments.push(...body.deployments)
        until = body?.pagination?.next
        if (!until) return deployments
      }
      throw new Error(`more than ${maxPages * limit} deployments; narrow PRODUCTION_ISOLATION_SINCE`)
    },
    getDeployment: idOrUrl => request('GET', `/v13/deployments/${encodeURIComponent(idOrUrl)}`),
    promote: (projectId, deploymentId) => request('POST', `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`),
    rollback: (projectId, deploymentId) => request('POST', `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`),
  }
}

// Replays recorded responses keyed by "METHOD /path" for workflow_dispatch dry runs and tests.
export function createRecordedFetch(recording) {
  return async url => {
    const key = `GET ${new URL(url).pathname}`
    if (!(key in recording)) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(recording[key]), { status: 200 })
  }
}
