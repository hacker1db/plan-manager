// Trusted drift audit: compares the real Vercel configuration of both projects with
// config/env.contract.json, by NAME, TARGET and STORAGE TYPE only, and checks that production stays
// isolated from pull request code. Runs from main only (env-drift.yml, environment `env-audit`).
//
// Checks:
//   - every variable the contract requires in production exists in the production project for
//     the production target, with at least the contract's minimum storage type;
//   - the same for preview and development in the preview project;
//   - the preview project holds no production-target variables (its production target is never
//     used, so an accidental production build there fails closed at the build guard);
//   - the production project is not connected to Git (amendment 1);
//   - every production-project deployment since the isolation cut-over was created by release.yml
//     from main (meta.planManagerRef == "main"), so no non-main code ran there (amendment 9).
//
//   node scripts/ci/env-drift.mjs [--recording <file>] [--report <file>]
//   env: VERCEL_TOKEN, VERCEL_PROJECT_ID_PRODUCTION, VERCEL_PROJECT_ID_PREVIEW, [VERCEL_TEAM_ID],
//        [PRODUCTION_ISOLATION_SINCE], [GITHUB_TOKEN, GITHUB_REPOSITORY for the alert issue]
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { STORAGE_RANK, loadContract, minimumStorage, requiredIn } from '../env-contract.mjs'
import { reconcileAlert } from './alert-issue.mjs'
import { createGitHubClient } from './github-client.mjs'
import { createRecordedFetch, createVercelClient } from './vercel-client.mjs'

export const ALERT_TITLE = 'Alert: Vercel configuration drift'
// Legacy "secret" type is encrypted at rest; "system" variables are Vercel-managed and never count.
const TYPE_RANK = { ...STORAGE_RANK, secret: STORAGE_RANK.encrypted }

function checkTargets(contract, env, project, targets, problems) {
  for (const target of targets) {
    for (const variable of requiredIn(contract, target)) {
      const records = env.filter(record => record.key === variable.name && record.target.includes(target))
      const minimum = minimumStorage(contract, variable, target)
      if (records.length === 0) problems.push({ check: 'missing', project, target, name: variable.name, detail: `required in ${target}` })
      else if (!records.some(record => (TYPE_RANK[record.type] ?? -1) >= STORAGE_RANK[minimum])) {
        problems.push({ check: 'storage-type', project, target, name: variable.name, detail: `type ${records.map(record => record.type).join('/')} is below the minimum "${minimum}"` })
      }
    }
  }
}

// Pure audit over already-fetched metadata. Returns a list of problems (names and IDs only).
export function auditConfiguration({ contract, production, preview, isolationSince = 0 }) {
  const problems = []
  checkTargets(contract, production.env, 'production', ['production'], problems)
  checkTargets(contract, preview.env, 'preview', ['preview', 'development'], problems)
  for (const record of preview.env) {
    if (record.target.includes('production') && record.type !== 'system') problems.push({ check: 'preview-production-target', project: 'preview', target: 'production', name: record.key, detail: 'the preview project must not hold production-target variables' })
  }
  if (production.project?.link) problems.push({ check: 'git-connected', project: 'production', detail: `the production project is connected to Git (${production.project.link.type ?? 'unknown'}); disconnect it so only release.yml deploys` })
  for (const deployment of production.deployments) {
    const created = Number(deployment.createdAt ?? deployment.created ?? 0)
    if (created < isolationSince) continue
    const meta = deployment.meta ?? {}
    const fromRelease = deployment.target === 'production' && meta.planManagerRef === 'main' && /^[0-9a-f]{40}$/.test(meta.planManagerSha ?? '')
    if (!fromRelease) problems.push({ check: 'non-main-deployment', project: 'production', detail: `deployment ${deployment.uid ?? deployment.id} (target ${deployment.target ?? 'preview'}) was not created by release.yml from main` })
  }
  return problems
}

export function renderReport(problems, { dryRun = false } = {}) {
  const lines = [
    `# ${dryRun ? '[dry run] ' : ''}Vercel configuration drift`,
    '',
    problems.length === 0 ? 'No drift: both projects match config/env.contract.json and production is isolated.' : `${problems.length} problem(s). Names, targets, types and deployment IDs only; no values were read.`,
    '',
  ]
  if (problems.length) {
    lines.push('| Check | Project | Target | Name | Detail |', '| --- | --- | --- | --- | --- |')
    for (const problem of problems) lines.push(`| ${problem.check} | ${problem.project} | ${problem.target ?? ''} | ${problem.name ? `\`${problem.name}\`` : ''} | ${problem.detail} |`)
    lines.push('', 'Fix: see docs/operations/ci-cd.md "Drift audit".')
  }
  return `${lines.join('\n')}\n`
}

export async function collect(vercel, { productionId, previewId, isolationSince }) {
  const [productionEnv, previewEnv, project, deployments] = await Promise.all([
    vercel.listEnv(productionId),
    vercel.listEnv(previewId),
    vercel.getProject(productionId),
    vercel.listDeployments(productionId, { since: isolationSince || undefined }),
  ])
  return { production: { env: productionEnv, project: { link: project?.link ?? null }, deployments }, preview: { env: previewEnv } }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const recording = arg('--recording')
  const reportPath = arg('--report')
  try {
    const contract = loadContract()
    const env = process.env
    const isolationSince = env.PRODUCTION_ISOLATION_SINCE ? Date.parse(env.PRODUCTION_ISOLATION_SINCE) : 0
    if (Number.isNaN(isolationSince)) throw new Error('PRODUCTION_ISOLATION_SINCE must be an ISO date')
    const vercel = recording
      ? createVercelClient({ token: 'dry-run', fetchImpl: createRecordedFetch(JSON.parse(readFileSync(recording, 'utf8'))) })
      : createVercelClient({ token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID })
    const productionId = recording ? 'prj_production' : env.VERCEL_PROJECT_ID_PRODUCTION
    const previewId = recording ? 'prj_preview' : env.VERCEL_PROJECT_ID_PREVIEW
    if (!productionId || !previewId) throw new Error('VERCEL_PROJECT_ID_PRODUCTION and VERCEL_PROJECT_ID_PREVIEW must be set')
    const problems = auditConfiguration({ contract, ...(await collect(vercel, { productionId, previewId, isolationSince })), isolationSince })
    const report = renderReport(problems, { dryRun: Boolean(recording) })
    process.stdout.write(report)
    if (reportPath) writeFileSync(reportPath, report)
    if (!recording && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
      const outcome = await reconcileAlert(createGitHubClient({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY }), { title: ALERT_TITLE, failing: problems.length > 0, body: report })
      process.stdout.write(`Alert issue: ${outcome}\n`)
    }
    process.exit(problems.length ? 1 : 0)
  } catch (error) {
    process.stderr.write(`Drift audit failed closed: ${error.message}\n`)
    if (!recording && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
      const body = `# Vercel configuration drift\n\nThe audit could not run: ${error.message}\n\nSee docs/operations/ci-cd.md "Drift audit".\n`
      await reconcileAlert(createGitHubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }), { title: ALERT_TITLE, failing: true, body }).catch(() => {})
    }
    process.exit(1)
  }
}
