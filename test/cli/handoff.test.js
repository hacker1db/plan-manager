import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { readPlan } from '../../dist/lib/metadata.js'
import { projectTracking } from '../../dist/lib/tracking.js'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-handoff-cli-'))
  const gh = join(dir, 'gh')
  // Fake gh: echoes back whichever PR URL it was asked for ($3 in `gh pr view <url> ...`).
  await writeFile(gh, `#!/bin/sh\nprintf '{"url":"%s","state":"OPEN","isDraft":false,"headRefOid":"abc1234","mergeCommit":null}' "$3"\n`)
  await chmod(gh, 0o755)
  const env = { ...process.env, PLAN_HOME: join(dir, 'plans'), XDG_CONFIG_HOME: join(dir, 'config'), PLAN_GH: gh }
  const plan = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input })
  try {
    assert.equal(plan(['create', '--title', 'Tracked', '--json']).status, 0)
    await fn({ plan })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const json = result => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const attach = (plan, provider) => json(plan(['session', 'attach', 'tracked', '--stdin', '--json'], JSON.stringify({ provider }))).executionId
const fromDisk = async plan => projectTracking((await readPlan(json(plan(['show', 'tracked', '--json'])).path)).meta)

test('session lead is explicit and ending it leaves no lead', async () => {
  await withEnv(async ({ plan }) => {
    const a = attach(plan, 'claude')
    const b = attach(plan, 'codex')
    assert.equal(json(plan(['session', 'lead', 'tracked', a, '--json'])).leadExecutionId, a)
    assert.equal(json(plan(['session', 'lead', 'tracked', a, '--json'])).duplicate, true)
    assert.equal(plan(['session', 'lead', 'tracked', '00000000-0000-4000-8000-000000000000']).status, 3)
    json(plan(['session', 'end', 'tracked', a, '--json']))
    const after = await fromDisk(plan)
    assert.equal(after.leadExecutionId, null)
    assert.equal(after.executions.find(item => item.id === b).endedAt, undefined)
    assert.equal(plan(['session', 'lead', 'tracked', a]).status, 2, 'an ended session cannot lead')
  })
})

test('handoff moves the lead, ends the predecessor and keeps sessions and PRs on disk', async () => {
  await withEnv(async ({ plan }) => {
    const a = attach(plan, 'claude')
    const b = attach(plan, 'codex')
    json(plan(['session', 'lead', 'tracked', a, '--json']))
    json(plan(['pr', 'attach', 'tracked', 'https://github.com/owner/repo/pull/1', '--json']))
    json(plan(['pr', 'attach', 'tracked', 'https://github.com/owner/repo/pull/2', '--role', 'followup', '--json']))
    assert.equal(plan(['handoff', 'tracked', a, b]).status, 2, '--reason is required')
    assert.equal(plan(['handoff', 'tracked', a, '00000000-0000-4000-8000-000000000000', '--reason', 'x']).status, 3)
    const args = ['handoff', 'tracked', a, b, '--reason', 'context full', '--scope', 'phase 2', '--end-previous', '--idempotency-key', 'h1', '--json']
    const result = json(plan(args))
    assert.equal(result.leadExecutionId, b)
    assert.equal(result.event.type, 'handoff')
    assert.equal(json(plan(args)).duplicate, true)
    assert.equal(plan(['handoff', 'tracked', b, a, '--reason', 'back']).status, 2, 'an ended session cannot receive a handoff')
    // Each plan call is a new process, so this disk read is the restart check.
    const projection = await fromDisk(plan)
    assert.equal(projection.leadExecutionId, b)
    assert.deepEqual(projection.executions.map(item => [item.id, item.provider, item.endedAt !== undefined]), [[a, 'claude', true], [b, 'codex', false]])
    assert.deepEqual(projection.prs.map(item => item.number), [1, 2])
    assert.deepEqual(projection.handoffs.map(item => [item.fromExecutionId, item.toExecutionId, item.reason, item.scope, item.endPrevious]), [[a, b, 'context full', 'phase 2', true]])
  })
})
