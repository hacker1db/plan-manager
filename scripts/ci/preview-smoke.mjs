// Advisory smoke test of a PR's preview deployment, run by preview-smoke.yml (workflow_run of ci,
// default-branch definition). It never checks out or runs PR code: it finds the preview project's
// deployment for the PR head commit through the Vercel API, then makes two read-only requests with
// the preview project's bypass secret (which is treated as exposed to PR code and opens only
// preview deployments). Only status codes and the health status string are read; the PR controls
// the response body, so nothing else from it is used or logged. Result: a `preview-smoke` commit
// status on the head commit.
//
//   env: VERCEL_TOKEN, VERCEL_PROJECT_ID_PREVIEW, VERCEL_PROTECTION_BYPASS_PREVIEW, [VERCEL_TEAM_ID],
//        HEAD_SHA, HEAD_REPOSITORY, GITHUB_REPOSITORY, GITHUB_TOKEN (statuses: write)
import { pathToFileURL } from 'node:url'
import { createGitHubClient } from './github-client.mjs'
import { httpProbe } from './release.mjs'
import { createVercelClient } from './vercel-client.mjs'

export const STATUS_CONTEXT = 'preview-smoke'

export async function findPreviewDeployment(vercel, { projectId, sha, sleep, now, timeoutMs = 15 * 60_000, intervalMs = 15_000 }) {
  const deadline = now() + timeoutMs
  for (;;) {
    const candidates = (await vercel.listDeployments(projectId, { limit: 20, maxPages: 1 })).filter(deployment => deployment.meta?.githubCommitSha === sha)
    const newest = candidates.sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0]
    if (newest) {
      const deployment = await vercel.getDeployment(newest.uid ?? newest.id)
      if (deployment.readyState === 'READY') return deployment
      if (['ERROR', 'CANCELED'].includes(deployment.readyState)) throw new Error(`preview deployment ${deployment.id} ended ${deployment.readyState}`)
    }
    if (now() >= deadline) throw new Error(`no READY preview deployment for ${sha.slice(0, 12)} within ${Math.round(timeoutMs / 60_000)} minutes`)
    await sleep(intervalMs)
  }
}

export async function smoke({ vercel, probe, sleep, now, config }) {
  if (config.headRepository !== config.repository) return { skipped: true, failures: [] }
  const deployment = await findPreviewDeployment(vercel, { projectId: config.projectId, sha: config.sha, sleep, now })
  const failures = []
  if (deployment.projectId !== config.projectId) failures.push(`deployment ${deployment.id} belongs to another project`)
  if (typeof deployment.url !== 'string' || !/^[a-z0-9-]+\.vercel\.app$/.test(deployment.url)) failures.push(`deployment ${deployment.id} has an unexpected URL`)
  if (failures.length) return { skipped: false, failures, deploymentId: deployment.id }
  const headers = { 'x-vercel-protection-bypass': config.bypass }
  const live = await probe(`https://${deployment.url}/api/health`, { headers })
  if (live.status !== 200 || live.json?.status !== 'ok') failures.push(`/api/health returned ${live.status}`)
  const anonymous = await probe(`https://${deployment.url}/api/v1/plans`, { headers })
  if (anonymous.status !== 401) failures.push(`/api/v1/plans without a session returned ${anonymous.status}, expected 401`)
  return { skipped: false, failures, deploymentId: deployment.id }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const github = createGitHubClient({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY })
  const config = { projectId: env.VERCEL_PROJECT_ID_PREVIEW, sha: env.HEAD_SHA, bypass: env.VERCEL_PROTECTION_BYPASS_PREVIEW, headRepository: env.HEAD_REPOSITORY, repository: env.GITHUB_REPOSITORY }
  let state = 'error'
  let description
  try {
    if (!/^[0-9a-f]{40}$/.test(config.sha ?? '')) throw new Error('HEAD_SHA is not a commit SHA')
    for (const [key, value] of Object.entries(config)) if (!value) throw new Error(`${key} is not set`)
    const result = await smoke({ vercel: createVercelClient({ token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID }), probe: httpProbe, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, config })
    if (result.skipped) {
      process.stdout.write('Fork pull request: preview smoke skipped.\n')
      process.exit(0)
    }
    state = result.failures.length ? 'failure' : 'success'
    description = result.failures.length ? result.failures.join('; ') : `Preview ${result.deploymentId} is up and enforces auth`
  } catch (error) {
    description = error.message
  }
  process.stdout.write(`${state}: ${description}\n`)
  await github.request('POST', `/repos/{repo}/statuses/${config.sha}`, { state, context: STATUS_CONTEXT, description: description.slice(0, 140), target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` })
  process.exit(state === 'success' ? 0 : 1)
}
