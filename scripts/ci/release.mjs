// Staged production release, run by release.yml after the owner approves the `production`
// environment. release.yml has already built main at `sha` and created a staged production
// deployment with `vercel deploy --prebuilt --prod --skip-domain`; this script is the only
// promotion writer:
//
//   0. abort (no mutation) if main has moved past `sha`
//   1. wait for the deployment to be READY (fail fast on ERROR/CANCELED); check it is ours
//   2. record PREV, the deployment production currently serves
//   3. read-only checks on the staged URL (liveness, dependency detail, auth still enforced)
//   4. stale guard: main HEAD is still `sha` and production still serves PREV
//   5. promote; wait for the alias job; check the domain serves us; smoke the domain
//   6. on failure after promote: if production still serves us, roll back to PREV by ID with the
//      rollback API, wait for that alias job, and check the domain serves PREV again
//
// Every network dependency is injected so tests can assert the exact sequence of mutations.
// Platform facts (verified against Vercel docs 2026-11-26, see docs/operations/ci-cd.md):
// promote is POST /v10/projects/{id}/promote/{dpl}; rollback is POST /v1/projects/{id}/rollback/{dpl}
// and on Hobby only to the immediately previous production deployment; both complete
// asynchronously, so completion is polled on the project (`lastAliasRequest`, `targets.production`),
// then checked on the domain. Those two project fields are from the API reference and were
// exercised only with a fake client; see docs/operations/ci-cd.md.
import { pathToFileURL } from 'node:url'
import { reconcileAlert } from './alert-issue.mjs'
import { createGitHubClient } from './github-client.mjs'
import { createVercelClient } from './vercel-client.mjs'

export const RELEASE_ALERT = 'Alert: production release failed'
export const ROLLBACK_ALERT = 'CRITICAL: production rollback failed'

export class ReleaseError extends Error {
  constructor(outcome, message) {
    super(message)
    this.name = 'ReleaseError'
    this.outcome = outcome
  }
}

const current = project => project?.targets?.production?.id ?? null

async function poll(check, { timeoutMs, intervalMs, sleep, now, what }) {
  const deadline = now() + timeoutMs
  for (;;) {
    const result = await check()
    if (result !== undefined) return result
    if (now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(intervalMs)
  }
}

export async function waitForReady(vercel, url, options) {
  return poll(async () => {
    const deployment = await vercel.getDeployment(url)
    if (deployment.readyState === 'READY') return deployment
    if (['ERROR', 'CANCELED'].includes(deployment.readyState)) throw new ReleaseError('deploy-failed', `deployment ${deployment.id} ended ${deployment.readyState}`)
    return undefined
  }, { ...options, timeoutMs: options.readyTimeoutMs, what: 'the deployment to be READY' })
}

// Alias jobs (promote and rollback) are asynchronous. Done when the project's last alias request
// targeted `deploymentId` and succeeded and production points at it; a failed job is an error.
export async function waitForAlias(vercel, projectId, deploymentId, options) {
  return poll(async () => {
    const project = await vercel.getProject(projectId)
    const job = project.lastAliasRequest
    if (job?.toDeploymentId === deploymentId && job.jobStatus === 'failed') throw new Error(`alias job to ${deploymentId} failed`)
    // If the project reports no job for this target, rely on the production pointer (and the domain
    // check the caller does next).
    const jobDone = job?.toDeploymentId === deploymentId ? job.jobStatus === 'succeeded' : true
    if (jobDone && current(project) === deploymentId) return project
    return undefined
  }, { ...options, timeoutMs: options.aliasTimeoutMs, what: `the alias job to ${deploymentId}` })
}

async function domainServes(vercel, domain, deploymentId) {
  const served = await vercel.getDeployment(domain)
  if (served.id !== deploymentId) throw new Error(`${domain} serves ${served.id}, expected ${deploymentId}`)
}

// Read-only HTTP checks. `probe` returns { status, json } and never exposes bodies beyond the
// parsed health JSON; failures name the check only.
export async function healthChecks(probe, base, { bypass, detailToken, staged }) {
  const protection = staged && bypass ? { 'x-vercel-protection-bypass': bypass } : {}
  const failures = []
  const live = await probe(`${base}/api/health`, { headers: protection })
  if (live.status !== 200 || live.json?.status !== 'ok') failures.push(`/api/health returned ${live.status}`)
  const detail = await probe(`${base}/api/health/detail`, { headers: { ...protection, authorization: `Bearer ${detailToken}` } })
  const checks = detail.json?.checks ?? {}
  if (detail.status !== 200 || detail.json?.status !== 'ok') failures.push(`/api/health/detail returned ${detail.status} (${Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name).join(', ') || 'no checks'} failing)`)
  const anonymousDetail = await probe(`${base}/api/health/detail`, { headers: protection })
  if (anonymousDetail.status !== 401) failures.push(`/api/health/detail without a token returned ${anonymousDetail.status}, expected 401`)
  const anonymousApi = await probe(`${base}/api/v1/plans`, { headers: protection })
  if (anonymousApi.status !== 401) failures.push(`/api/v1/plans without a session returned ${anonymousApi.status}, expected 401`)
  return failures
}

export async function release({ vercel, mainHead, probe, log, sleep, now, config }) {
  const options = { sleep, now, intervalMs: config.pollIntervalMs ?? 5_000, readyTimeoutMs: config.readyTimeoutMs ?? 20 * 60_000, aliasTimeoutMs: config.aliasTimeoutMs ?? 5 * 60_000 }
  const { projectId, sha, deploymentUrl, productionDomain } = config

  if (await mainHead() !== sha) return { outcome: 'superseded' }

  const deployment = await waitForReady(vercel, deploymentUrl, options)
  if (deployment.projectId !== projectId || deployment.target !== 'production' || deployment.meta?.planManagerSha !== sha) {
    throw new ReleaseError('wrong-deployment', `deployment ${deployment.id} is not the staged production deployment of ${sha.slice(0, 12)} in the production project`)
  }

  const prev = current(await vercel.getProject(projectId))
  if (!prev) throw new ReleaseError('no-previous', 'could not read the current production deployment')
  if (prev === deployment.id) return { outcome: 'already-live', deploymentId: deployment.id }
  log(`Staged ${deployment.id}; production serves ${prev}.`)

  const stagedFailures = await healthChecks(probe, `https://${deployment.url}`, { ...config, staged: true })
  if (stagedFailures.length) throw new ReleaseError('staged-checks-failed', `staged deployment failed checks: ${stagedFailures.join('; ')}`)

  if (await mainHead() !== sha) return { outcome: 'superseded', deploymentId: deployment.id }
  if (current(await vercel.getProject(projectId)) !== prev) throw new ReleaseError('external-promotion', `production changed from ${prev} while this release ran; not promoting`)

  log(`Promoting ${deployment.id}.`)
  let failure
  try {
    await vercel.promote(projectId, deployment.id)
    await waitForAlias(vercel, projectId, deployment.id, options)
    await domainServes(vercel, productionDomain, deployment.id)
    const liveFailures = await healthChecks(probe, `https://${productionDomain}`, { ...config, staged: false })
    if (liveFailures.length) failure = `production checks failed: ${liveFailures.join('; ')}`
  } catch (error) {
    failure = `promotion did not complete: ${error.message}`
  }
  if (!failure) return { outcome: 'released', deploymentId: deployment.id, previousId: prev }

  log(`${failure}. Checking before rollback.`)
  const now_ = current(await vercel.getProject(projectId))
  if (now_ !== deployment.id && now_ !== prev) throw new ReleaseError('external-promotion', `${failure}; production now serves ${now_}, which this release did not promote, so it will not roll back`)
  if (now_ === prev) throw new ReleaseError('promote-failed', `${failure}; production still serves ${prev}`)
  try {
    await vercel.rollback(projectId, prev)
    await waitForAlias(vercel, projectId, prev, options)
    await domainServes(vercel, productionDomain, prev)
  } catch (error) {
    throw new ReleaseError('rollback-failed', `${failure}; rollback to ${prev} failed: ${error.message}`)
  }
  throw new ReleaseError('rolled-back', `${failure}; rolled back to ${prev}`)
}

// Cancels release runs still waiting for approval that an approved or newer run supersedes, so a
// stale run cannot hold the release lock (amendment 6). Never touches running or finished runs.
export async function cancelSupersededRuns(github, { currentRunId, currentRunNumber }) {
  const waiting = (await github.request('GET', '/repos/{repo}/actions/workflows/release.yml/runs?status=waiting&per_page=50')).workflow_runs ?? []
  const stale = waiting.filter(run => run.id !== currentRunId && run.run_number < currentRunNumber)
  for (const run of stale) await github.request('POST', `/repos/{repo}/actions/runs/${run.id}/cancel`)
  return stale.map(run => run.id)
}

export async function httpProbe(url, { headers = {} } = {}) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  let json = null
  if (/\/api\/health(\/detail)?$/.test(new URL(url).pathname)) {
    try {
      const body = await response.json()
      json = { status: typeof body?.status === 'string' ? body.status : null, checks: Object.fromEntries(Object.entries(body?.checks ?? {}).map(([name, ok]) => [name, ok === true])) }
    } catch {}
  }
  return { status: response.status, json }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const github = createGitHubClient({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY })
  if (process.argv.includes('--cancel-superseded')) {
    const cancelled = await cancelSupersededRuns(github, { currentRunId: Number(env.GITHUB_RUN_ID), currentRunNumber: Number(env.GITHUB_RUN_NUMBER) })
    process.stdout.write(cancelled.length ? `Cancelled superseded release runs waiting for approval: ${cancelled.join(', ')}\n` : 'No superseded release runs waiting.\n')
    process.exit(0)
  }
  const config = {
    projectId: env.VERCEL_PROJECT_ID_PRODUCTION,
    sha: env.RELEASE_SHA,
    deploymentUrl: arg('--deployment-url'),
    productionDomain: env.PRODUCTION_DOMAIN,
    bypass: env.VERCEL_PROTECTION_BYPASS_PRODUCTION,
    detailToken: env.PLAN_MANAGER_HEALTH_DETAIL_TOKEN,
  }
  let result
  let error
  try {
    for (const [key, value] of Object.entries(config)) if (!value) throw new ReleaseError('misconfigured', `${key} is not set`)
    result = await release({
      vercel: createVercelClient({ token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID }),
      mainHead: async () => (await github.request('GET', '/repos/{repo}/commits/main')).sha,
      probe: httpProbe,
      log: line => process.stdout.write(`${line}\n`),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: Date.now,
      config,
    })
  } catch (caught) {
    error = caught
  }
  const run = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  if (!error) {
    process.stdout.write(`Release ${result.outcome}${result.deploymentId ? ` (${result.deploymentId})` : ''}.\n`)
    if (result.outcome === 'released') await reconcileAlert(github, { title: RELEASE_ALERT, failing: false, body: '' })
    process.exit(0)
  }
  const outcome = error.outcome ?? 'error'
  process.stderr.write(`Release ${outcome}: ${error.message}\n`)
  const critical = outcome === 'rollback-failed'
  const body = `# ${critical ? 'Production rollback failed' : 'Production release failed'}\n\n- Commit: ${config.sha}\n- Outcome: \`${outcome}\`\n- Detail: ${error.message}\n- Run: ${run}\n\n${critical ? 'Production may be serving a deployment that failed its checks. Follow docs/operations/ci-cd.md "Manual rollback" now.' : 'See docs/operations/ci-cd.md "Release".'}\n`
  await reconcileAlert(github, { title: critical ? ROLLBACK_ALERT : RELEASE_ALERT, failing: true, body }).catch(alertError => process.stderr.write(`Could not open the alert issue: ${alertError.message}\n`))
  process.exit(1)
}
