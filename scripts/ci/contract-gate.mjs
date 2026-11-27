// Contract-change gate for pull requests. A PR that adds a production requirement, adds a secret a
// trusted GitHub environment must hold, or changes a variable's check would fail the next
// production build (or release) unless someone first provisions the real value. This gate fails
// such a PR until the REPOSITORY OWNER confirms provisioning by setting a commit status on the PR
// head commit:
//
//   gh api repos/<owner>/<repo>/statuses/<head-sha> -f state=success -f context=env-provisioned \
//     -f description="Provisioned in Vercel"
//
// A label is not used because any account with write access (including the agent identity) can
// apply one. Statuses created by anyone other than the owner are ignored. The gate needs only a
// read-only GITHUB_TOKEN and never sees a variable value.
//
//   node scripts/ci/contract-gate.mjs --base <sha>
//   env: GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, HEAD_SHA, GITHUB_TOKEN (read-only)
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { CONTRACT_PATH, loadContract, root, validateContract } from '../env-contract.mjs'

export const STATUS_CONTEXT = 'env-provisioned'

const byName = contract => new Map((contract?.variables ?? []).map(variable => [variable.name, variable]))

// Changes that need a real value provisioned before merge, as { name, reason } in head contract order.
export function requirementChanges(base, head) {
  const before = byName(base)
  const changes = []
  for (const variable of head.variables) {
    const old = before.get(variable.name)
    if (variable.store === 'vercel' && variable.requiredIn.includes('production') && !old?.requiredIn?.includes('production')) {
      changes.push({ name: variable.name, reason: old ? 'now required in Vercel production' : 'new variable required in Vercel production' })
    }
    for (const environment of variable.githubEnvironments ?? []) {
      if (!(old?.githubEnvironments ?? []).includes(environment)) changes.push({ name: variable.name, reason: `newly required in GitHub environment "${environment}"` })
    }
    if (old && JSON.stringify(old.validator) !== JSON.stringify(variable.validator)) changes.push({ name: variable.name, reason: 'build check changed' })
  }
  return changes
}

// Latest owner-created status for the gate context decides; everyone else's statuses are ignored.
export function ownerApproval(statuses, owner) {
  const relevant = statuses.filter(status => status.context === STATUS_CONTEXT)
  const fromOwner = relevant.filter(status => status.creator?.login?.toLowerCase() === owner.toLowerCase())
  const latest = fromOwner.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  return { approved: latest?.state === 'success', ignored: relevant.length - fromOwner.length, latestState: latest?.state ?? null }
}

export async function runGate({ base, head, owner, headSha, listStatuses, log = text => process.stdout.write(`${text}\n`) }) {
  const changes = requirementChanges(base, head)
  if (changes.length === 0) {
    log('Contract gate: no new production or release requirements and no changed checks.')
    return 0
  }
  log(`Contract gate: this PR changes what must be provisioned before merge:\n${changes.map(change => `  - ${change.name}: ${change.reason}`).join('\n')}`)
  const approval = ownerApproval(await listStatuses(headSha), owner)
  if (approval.ignored > 0) log(`Ignored ${approval.ignored} "${STATUS_CONTEXT}" status(es) not created by the repository owner (${owner}).`)
  if (approval.approved) {
    log(`Owner ${owner} confirmed provisioning with a "${STATUS_CONTEXT}" status on ${headSha}. Gate passed.`)
    return 0
  }
  log([
    `Gate failed: the repository owner (${owner}) has not confirmed provisioning for commit ${headSha}.`,
    'Owner: set each listed variable in Vercel (or the named GitHub environment) first, check names with',
    '`pnpm check:vercel-env`, then run:',
    `  gh api repos/<owner>/<repo>/statuses/${headSha} -f state=success -f context=${STATUS_CONTEXT} -f description="Provisioned"`,
    'and re-run this job. A new push needs a new status. See docs/operations/ci-cd.md.',
  ].join('\n'))
  return 1
}

function baseContract(baseSha) {
  let text
  try {
    text = execFileSync('git', ['show', `${baseSha}:${CONTRACT_PATH}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { variables: [] } // Base predates the contract: everything required now counts as new.
  }
  return validateContract(JSON.parse(text))
}

function githubStatuses(repository, token) {
  return async sha => {
    const statuses = []
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/statuses?per_page=100&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      })
      if (!response.ok) throw new Error(`GitHub statuses request failed with HTTP ${response.status}`)
      const batch = await response.json()
      statuses.push(...batch)
      if (batch.length < 100) break
    }
    return statuses
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseIndex = process.argv.indexOf('--base')
  const baseSha = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined
  const { GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_OWNER: owner, HEAD_SHA: headSha, GITHUB_TOKEN: token } = process.env
  if (!baseSha || !repository || !owner || !headSha || !token) {
    process.stderr.write('usage: contract-gate.mjs --base <sha> with GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, HEAD_SHA and GITHUB_TOKEN set\n')
    process.exit(2)
  }
  try {
    process.exit(await runGate({ base: baseContract(baseSha), head: loadContract(), owner, headSha, listStatuses: githubStatuses(repository, token) }))
  } catch (error) {
    process.stderr.write(`Contract gate failed closed: ${error.message}\n`)
    process.exit(1)
  }
}
