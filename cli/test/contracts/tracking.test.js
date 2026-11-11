import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-tracking-cli-'))
  const gh = join(dir, 'gh')
  const state = join(dir, 'pr-state')
  await writeFile(state, 'OPEN')
  // Fake gh: echoes a PR whose state comes from a file, so tests can simulate a merge.
  await writeFile(gh, `#!/bin/sh\nprintf '{"url":"https://github.com/Owner/Repo/pull/7","state":"%s","isDraft":false,"headRefOid":"ABC1234","mergeCommit":null}' "$(cat '${state}')"\n`)
  await chmod(gh, 0o755)
  const env = { ...process.env, PLAN_HOME: join(dir, 'plans'), XDG_CONFIG_HOME: join(dir, 'config'), PLAN_GH: gh }
  const plan = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input })
  try {
    assert.equal(plan(['create', '--title', 'Tracked', '--json']).status, 0)
    await fn({ dir, plan, state })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const json = result => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('session attach is idempotent and session end closes it', async () => {
  await withEnv(async ({ plan }) => {
    const details = JSON.stringify({ provider: 'codex', nativeSessionId: 'thread-1', branch: 'feat/x', environment: { type: 'container', id: '00000000-0000-4000-8000-0000000000c0' } })
    const first = json(plan(['session', 'attach', 'tracked', '--stdin', '--idempotency-key', 'run-1', '--json'], details))
    const retry = json(plan(['session', 'attach', 'tracked', '--stdin', '--idempotency-key', 'run-1', '--json'], details))
    assert.equal(first.duplicate, false)
    assert.equal(retry.duplicate, true)
    assert.equal(retry.executionId, first.executionId)
    assert.equal(retry.revision, first.revision)
    const execution = first.event.data.execution
    assert.equal(execution.environment.type, 'container')
    assert.notEqual(execution.environment.parentId, undefined, 'container records its controlling host')
    assert.equal(plan(['session', 'attach', 'tracked', '--stdin'], JSON.stringify({ provider: 'claude', token: 'x' })).status, 2)
    const ended = json(plan(['session', 'end', 'tracked', first.executionId, '--json']))
    assert.equal(ended.event.type, 'session.ended')
    assert.equal(json(plan(['session', 'end', 'tracked', first.executionId, '--json'])).duplicate, true)
  })
})

test('pr attach verifies with gh, dedupes, refreshes changes and detaches', async () => {
  await withEnv(async ({ plan, state }) => {
    const attached = json(plan(['pr', 'attach', 'tracked', 'https://github.com/owner/repo/pull/7', '--role', 'partial', '--json']))
    assert.equal(attached.url, 'https://github.com/Owner/Repo/pull/7')
    assert.equal(json(plan(['pr', 'attach', 'tracked', 'https://github.com/Owner/Repo/pull/7', '--json'])).duplicate, true)
    assert.equal(json(plan(['pr', 'refresh', 'tracked', '--json'])).prs[0].changed, false)
    await writeFile(state, 'MERGED')
    const refreshed = json(plan(['pr', 'refresh', 'tracked', '--json']))
    assert.equal(refreshed.prs[0].state, 'merged')
    assert.equal(refreshed.prs[0].changed, true)
    assert.equal(refreshed.stage, 'planning', 'a merged PR never moves the plan stage')
    assert.equal(plan(['pr', 'attach', 'tracked', 'https://github.com/other/repo/pull/7']).status, 2, 'gh resolving to a different PR is rejected')
    const detached = json(plan(['pr', 'detach', 'tracked', attached.prId, '--json']))
    assert.equal(detached.event.revokes, attached.event.id)
  })
})

test('stage, status and revision guards', async () => {
  await withEnv(async ({ plan }) => {
    const created = json(plan(['show', 'tracked', '--json']))
    assert.equal(created.stage, 'planning')
    assert.equal(plan(['stage', 'tracked', 'shipped']).status, 2)
    assert.equal(plan(['stage', 'tracked', 'in_progress']).status, 2, 'work cannot start before plan approval')
    const staged = json(plan(['stage', 'tracked', 'awaiting_plan_review', '--if-revision', created.revision, '--json']))
    assert.equal(staged.stage, 'awaiting_plan_review')
    assert.equal(plan(['review', 'record', 'tracked', 'plan', '--decision', 'approved', '--if-revision', created.revision]).status, 5)
    assert.equal(plan(['status', 'tracked', 'completed']).status, 2)
    assert.equal(plan(['stage', 'tracked', 'completed']).status, 2, 'completion goes through plan complete')
  })
})

test('body updates keep tracking; imports drop foreign tracking', async () => {
  await withEnv(async ({ dir, plan }) => {
    json(plan(['stage', 'tracked', 'awaiting_plan_review', '--json']))
    json(plan(['update', 'tracked', '--stdin', '--json'], '# New body\n'))
    assert.equal(json(plan(['show', 'tracked', '--json'])).stage, 'awaiting_plan_review')
    const source = join(dir, 'foreign.md')
    const tracked = await readFile(json(plan(['show', 'tracked', '--json'])).path, 'utf8')
    await writeFile(source, tracked.replace(/^title: .*$/m, 'title: Foreign'))
    const imported = json(plan(['import', source, '--json']))
    assert.equal(imported.stage, 'planning')
    assert.doesNotMatch(await readFile(imported.path, 'utf8'), /tracking:/)
  })
})
