import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPlanHome } from '../../dist/lib/config.js'

test('getPlanHome defaults to the Obsidian-synced plans directory and honors PLAN_HOME', () => {
  const original = process.env.PLAN_HOME
  try {
    delete process.env.PLAN_HOME
    assert.equal(getPlanHome(), join(homedir(), 'notes', 'SecondBrain', '4.Resources', 'plans'))
    process.env.PLAN_HOME = '/tmp/custom-plans'
    assert.equal(getPlanHome(), '/tmp/custom-plans')
  } finally {
    if (original === undefined) delete process.env.PLAN_HOME
    else process.env.PLAN_HOME = original
  }
})
