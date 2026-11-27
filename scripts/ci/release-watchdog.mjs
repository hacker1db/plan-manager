// Release watchdog (read-only). Raises a deduplicated alert issue when main is not released in time.
// The clock starts when the owner APPROVES the release (the environment-gated `release` job starts),
// not at push, so a release waiting for approval never alarms (amendment 6). It also reports runs
// for older commits still waiting for approval, which would hold the release lock.
//
//   node scripts/ci/release-watchdog.mjs        env: GITHUB_TOKEN, GITHUB_REPOSITORY, [WATCHDOG_MINUTES]
import { pathToFileURL } from 'node:url'
import { reconcileAlert } from './alert-issue.mjs'
import { createGitHubClient } from './github-client.mjs'

export const ALERT_TITLE = 'Alert: production release watchdog'
export const RELEASE_WORKFLOW = 'release.yml'
export const RELEASE_JOB = 'release'
const MINUTE = 60_000

// Pure decision. `ciRun` is the latest ci.yml push run for headSha (or null); `runs` are release.yml
// runs for headSha; `releaseJob` is the gated job of the latest of those runs; `waiting` are all
// release.yml runs currently waiting for approval.
export function evaluate({ headSha, ciRun, runs, releaseJob, waiting, now, limitMinutes = 60 }) {
  const problems = []
  for (const run of waiting.filter(run => run.head_sha !== headSha)) {
    problems.push(`Release run ${run.id} for superseded commit ${run.head_sha.slice(0, 12)} is still waiting for approval and holds the release lock; reject it in the Actions UI.`)
  }
  const latest = [...runs].sort((a, b) => b.run_number - a.run_number)[0]
  if (!latest) {
    const finished = ciRun?.status === 'completed' && ciRun.conclusion === 'success' ? Date.parse(ciRun.updated_at) : null
    if (finished && now - finished > 30 * MINUTE) problems.push(`CI passed on main ${headSha.slice(0, 12)} more than 30 minutes ago but no release run started.`)
    return problems
  }
  if (latest.status === 'completed') {
    if (latest.conclusion !== 'success') problems.push(`Release run ${latest.id} for main ${headSha.slice(0, 12)} ended "${latest.conclusion}".`)
    return problems
  }
  const approvedAt = releaseJob?.started_at ? Date.parse(releaseJob.started_at) : null
  if (approvedAt && now - approvedAt > limitMinutes * MINUTE) problems.push(`Release run ${latest.id} for main ${headSha.slice(0, 12)} was approved ${Math.round((now - approvedAt) / MINUTE)} minutes ago and has not finished (limit ${limitMinutes}).`)
  return problems
}

export async function gather(github) {
  const head = await github.request('GET', '/repos/{repo}/commits/main')
  const headSha = head.sha
  let runs
  let waiting
  try {
    runs = (await github.request('GET', `/repos/{repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?head_sha=${headSha}&per_page=20`)).workflow_runs ?? []
    waiting = (await github.request('GET', `/repos/{repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?status=waiting&per_page=50`)).workflow_runs ?? []
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return { headSha, missingWorkflow: true }
    throw error
  }
  const ciRun = ((await github.request('GET', `/repos/{repo}/actions/workflows/ci.yml/runs?head_sha=${headSha}&event=push&per_page=5`)).workflow_runs ?? [])[0] ?? null
  const latest = [...runs].sort((a, b) => b.run_number - a.run_number)[0]
  const jobs = latest ? (await github.request('GET', `/repos/{repo}/actions/runs/${latest.id}/jobs?per_page=50`)).jobs ?? [] : []
  return { headSha, runs, waiting, ciRun, releaseJob: jobs.find(job => job.name === RELEASE_JOB) ?? null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const github = createGitHubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY })
    const state = await gather(github)
    if (state.missingWorkflow) {
      process.stdout.write(`${RELEASE_WORKFLOW} is not on main yet; nothing to watch.\n`)
      process.exit(0)
    }
    const problems = evaluate({ ...state, now: Date.now(), limitMinutes: Number(process.env.WATCHDOG_MINUTES || 60) })
    const body = problems.length ? `# Production release watchdog\n\n${problems.map(problem => `- ${problem}`).join('\n')}\n\nSee docs/operations/ci-cd.md "Release watchdog".\n` : ''
    process.stdout.write(problems.length ? body : `main ${state.headSha.slice(0, 12)}: release on track.\n`)
    process.stdout.write(`Alert issue: ${await reconcileAlert(github, { title: ALERT_TITLE, failing: problems.length > 0, body })}\n`)
    process.exit(problems.length ? 1 : 0)
  } catch (error) {
    process.stderr.write(`Release watchdog failed: ${error.message}\n`)
    process.exit(1)
  }
}
