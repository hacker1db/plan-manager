import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-history-cli-'))
  const gh = join(dir, 'gh')
  const state = join(dir, 'pr-state')
  await writeFile(state, 'OPEN')
  await writeFile(gh, `#!/bin/sh\nprintf '{"url":"https://github.com/Owner/Repo/pull/7","state":"%s","isDraft":false,"headRefOid":"ABC1234","mergeCommit":null}' "$(cat '${state}')"\n`)
  await chmod(gh, 0o755)
  const env = { ...process.env, PLAN_HOME: join(dir, 'plans'), XDG_CONFIG_HOME: join(dir, 'config'), PLAN_GH: gh }
  const plan = (args, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input })
  try {
    assert.equal(plan(['create', '--title', 'Tracked', '--json']).status, 0)
    await fn({ plan, state })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const json = result => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('history of an untracked plan is empty with its derived stage', async () => {
  await withEnv(async ({ plan }) => {
    const shown = json(plan(['show', 'tracked', '--json']))
    assert.deepEqual(json(plan(['history', 'tracked', '--json'])), { version: 1, id: shown.id, revision: shown.revision, stage: 'planning', events: [] })
    assert.match(plan(['history', 'tracked']).stdout, /No tracked events \(stage: planning\)/)
    assert.equal(plan(['history', 'missing']).status, 3)
    assert.equal(plan(['history']).status, 2)
  })
})

test('history lists events in seq order, marks revoked ones and writes nothing', async () => {
  await withEnv(async ({ plan, state }) => {
    json(plan(['stage', 'tracked', 'awaiting_plan_review', '--json']))
    json(plan(['review', 'record', 'tracked', 'plan', '--decision', 'approved', '--json']))
    json(plan(['stage', 'tracked', 'in_progress', '--reason', 'approved', '--json']))
    const session = json(plan(['session', 'attach', 'tracked', '--stdin', '--json'], JSON.stringify({ provider: 'claude', nativeSessionId: 'abc', observedAt: '2020-01-01T00:00:00.000Z' })))
    const attached = json(plan(['pr', 'attach', 'tracked', 'https://github.com/owner/repo/pull/7', '--json']))
    await writeFile(state, 'MERGED')
    json(plan(['pr', 'refresh', 'tracked', '--json']))
    json(plan(['pr', 'detach', 'tracked', attached.prId, '--json']))
    json(plan(['session', 'end', 'tracked', session.executionId, '--json']))

    const before = await readFile(attached.path, 'utf8')
    const history = json(plan(['history', 'tracked', '--json']))
    assert.deepEqual(Object.keys(history), ['version', 'id', 'revision', 'stage', 'events'])
    assert.equal(history.stage, 'in_progress')
    assert.deepEqual(history.events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(history.events.map(event => event.type), ['migrated', 'stage', 'plan.review', 'stage', 'session.attached', 'pr.attached', 'pr.observed', 'pr.observed', 'pr.detached', 'session.ended'])
    assert.equal(history.revision, json(plan(['show', 'tracked', '--json'])).revision)

    const lines = plan(['history', 'tracked']).stdout.trim().split('\n')
    assert.equal(lines.length, 10)
    assert.match(lines[0], /^1 .* migrated from active → planning/)
    assert.match(lines[3], /stage → in_progress \(approved\)/)
    assert.match(lines[4], /session attached claude abc on .* \[implementation\]  observed 2020-01-01T00:00:00.000Z/)
    assert.match(lines[5], /PR attached https:\/\/github\.com\/Owner\/Repo\/pull\/7 \(implements\)  \[revoked\]$/)
    assert.match(lines[7], /PR observed merged @abc1234/)
    assert.match(lines[8], /PR detached https:\/\/github\.com\/Owner\/Repo\/pull\/7/)
    assert.match(lines[2], /plan review approved @[0-9a-f]{7}/)
    assert.doesNotMatch(lines[3], /observed|revoked/)
    assert.equal(await readFile(attached.path, 'utf8'), before, 'history is read-only')
  })
})
