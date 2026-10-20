import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

test('open --remote dispatches to the hosted site and prints its URL when the opener fails', () => {
  const result = spawnSync(process.execPath, [BIN, 'open', '--remote'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAN_BROWSER: '/usr/bin/false',
      PLAN_MANAGER_URL: 'https://plans.example.test',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /browser opener exited with status 1/)
  assert.equal(result.stdout, 'Plan Manager: https://plans.example.test\n')
})
