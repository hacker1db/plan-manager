import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname
const PR = 'https://github.com/owner/repo/pull/7'

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-reviews-cli-'))
  const gh = join(dir, 'gh')
  const state = join(dir, 'pr-state')
  const head = join(dir, 'pr-head')
  await writeFile(state, 'OPEN')
  await writeFile(head, 'ABC1234')
  // Fake gh: PR state and head SHA come from files, so tests can simulate pushes and merges.
  await writeFile(gh, `#!/bin/sh\nprintf '{"url":"https://github.com/owner/repo/pull/7","state":"%s","isDraft":false,"headRefOid":"%s","mergeCommit":null}' "$(cat '${state}')" "$(cat '${head}')"\n`)
  await chmod(gh, 0o755)
  const env = { ...process.env, PLAN_HOME: join(dir, 'plans'), XDG_CONFIG_HOME: join(dir, 'config'), PLAN_GH: gh }
  const plan = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input })
  try {
    assert.equal(plan(['create', '--title', 'Reviewed', '--json']).status, 0)
    await fn({ plan, state, head })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const json = result => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const approve = plan => {
  json(plan(['stage', 'reviewed', 'awaiting_plan_review', '--json']))
  json(plan(['review', 'record', 'reviewed', 'plan', '--decision', 'approved', '--json']))
}

test('plan approval gates work, goes stale on body edits, and no-PR completion needs a rationale', async () => {
  await withEnv(async ({ plan }) => {
    assert.equal(plan(['review', 'record', 'reviewed', 'plan', '--decision', 'approved']).status, 2, 'nothing was submitted')
    json(plan(['stage', 'reviewed', 'awaiting_plan_review', '--json']))
    assert.equal(plan(['review', 'record', 'reviewed', 'plan', '--decision', 'maybe']).status, 2)
    assert.equal(json(plan(['review', 'record', 'reviewed', 'plan', '--decision', 'changes_requested', '--json'])).stage, 'planning')
    approve(plan)
    assert.equal(json(plan(['stage', 'reviewed', 'in_progress', '--json'])).stage, 'in_progress')
    assert.equal(plan(['complete', 'reviewed', '--reason', 'done']).status, 2, 'no PRs and no rationale')
    json(plan(['update', 'reviewed', '--stdin', '--json'], '# Changed scope\n'))
    const stale = plan(['complete', 'reviewed', '--reason', 'done', '--no-pr-rationale', 'docs only'])
    assert.equal(stale.status, 2)
    assert.match(stale.stderr, /body changed after approval/)
    json(plan(['stage', 'reviewed', 'planning', '--json']))
    approve(plan)
    json(plan(['stage', 'reviewed', 'in_progress', '--json']))
    const done = json(plan(['complete', 'reviewed', '--reason', 'done', '--no-pr-rationale', 'docs only', '--json']))
    assert.deepEqual([done.stage, done.status, done.event.data.noPrRationale], ['completed', 'completed', 'docs only'])
    assert.equal(plan(['stage', 'reviewed', 'planning']).status, 2, 'reopen is explicit')
    const reopened = json(plan(['reopen', 'reviewed', '--stage', 'planning', '--reason', 'missed a case', '--json']))
    assert.deepEqual([reopened.stage, reopened.status], ['planning', 'active'])
    assert.match(await readFile(reopened.path, 'utf8'), /type: completed/, 'completion history is kept')
  })
})

test('PR completion needs a merged PR with an approved review of its current head', async () => {
  await withEnv(async ({ plan, state, head }) => {
    const { prId } = json(plan(['pr', 'attach', 'reviewed', PR, '--json']))
    approve(plan)
    json(plan(['stage', 'reviewed', 'in_progress', '--json']))
    assert.equal(json(plan(['stage', 'reviewed', 'awaiting_pr_review', '--json'])).stage, 'awaiting_pr_review')
    assert.equal(plan(['review', 'record', 'reviewed', 'pr', PR, '--state', 'lgtm', '--head', 'abc1234']).status, 2)
    assert.equal(plan(['review', 'record', 'reviewed', 'pr', PR, '--state', 'approved']).status, 2, 'head SHA is required')
    const review = json(plan(['review', 'record', 'reviewed', 'pr', PR, '--state', 'approved', '--head', 'ABC1234', '--json']))
    assert.deepEqual([review.prId, review.event.data.headSha], [prId, 'abc1234'])
    assert.equal(plan(['complete', 'reviewed', '--reason', 'shipped']).status, 2, 'open PR is not merged')
    await writeFile(head, 'DEF5678')
    await writeFile(state, 'MERGED')
    json(plan(['pr', 'refresh', 'reviewed', '--json']))
    const stale = plan(['complete', 'reviewed', '--reason', 'shipped'])
    assert.equal(stale.status, 2)
    assert.match(stale.stderr, /approved review of its current head/)
    json(plan(['review', 'record', 'reviewed', 'pr', prId, '--state', 'approved', '--head', 'def5678', '--json']))
    const done = json(plan(['complete', 'reviewed', '--reason', 'shipped', '--json']))
    assert.deepEqual(done.event.data.coveredPrIds, [prId])
    assert.equal(done.status, 'completed')
  })
})
