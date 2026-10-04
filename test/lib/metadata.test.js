import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter, normalizeMeta, writePlan, readPlan } from '../../dist/lib/metadata.js'

test('parseFrontmatter extracts meta and body', () => {
  const content = `---\nid: abc\ntitle: Test\nstatus: active\n---\n\nBody here\n`
  const { meta, body } = parseFrontmatter(content)
  assert.equal(meta.id, 'abc')
  assert.equal(meta.title, 'Test')
  assert.equal(body.trim(), 'Body here')
})

test('parseFrontmatter handles missing frontmatter', () => {
  const content = 'Just body content'
  const { meta, body } = parseFrontmatter(content)
  assert.deepEqual(meta, {})
  assert.equal(body, 'Just body content')
})

test('normalizeMeta fills defaults', () => {
  const m = normalizeMeta({})
  assert.equal(typeof m.id, 'string')
  assert.equal(m.title, 'Untitled')
  assert.equal(m.status, 'active')
  assert.ok(Array.isArray(m.tags))
})

test('normalizeMeta coerces invalid status', () => {
  const m = normalizeMeta({ status: 'invalid' })
  assert.equal(m.status, 'active')
})

test('normalizeMeta preserves valid status', () => {
  assert.equal(normalizeMeta({ status: 'completed' }).status, 'completed')
  assert.equal(normalizeMeta({ status: 'archived' }).status, 'archived')
})

test('writePlan and readPlan roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-meta-test-'))
  try {
    const fp = join(dir, 'test.md')
    process.env.PLAN_HOME = dir
    const meta = {
      id: 'test123',
      title: 'Test Plan',
      status: 'active',
      created: '2024-01-01T00:00:00.000Z',
      updated: '2024-01-01T00:00:00.000Z',
      tags: ['a', 'b'],
    }
    await writePlan(fp, meta, 'Hello body')
    const parsed = await readPlan(fp)
    assert.equal(parsed.meta.id, 'test123')
    assert.equal(parsed.meta.title, 'Test Plan')
    assert.equal(parsed.meta.tags.length, 2)
    assert.ok(parsed.body.includes('Hello body'))
  } finally {
    delete process.env.PLAN_HOME
    await rm(dir, { recursive: true })
  }
})
