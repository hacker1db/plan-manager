import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateId, slugify, computeRevision } from '../../dist/lib/ids.js'

test('generateId returns 21-char string', () => {
  const id = generateId()
  assert.equal(typeof id, 'string')
  assert.equal(id.length, 21)
})

test('generateId produces unique values', () => {
  assert.notEqual(generateId(), generateId())
})

test('slugify basic', () => {
  assert.equal(slugify('My Plan! 2024'), 'my-plan-2024')
})

test('slugify trims leading/trailing dashes', () => {
  assert.equal(slugify('  hello world  '), 'hello-world')
})

test('slugify empty fallback', () => {
  assert.equal(slugify('!!!'), 'plan')
})

test('computeRevision is deterministic', async () => {
  const a = await computeRevision('hello world')
  const b = await computeRevision('hello world')
  assert.equal(a, b)
})

test('computeRevision differs for different content', async () => {
  const a = await computeRevision('hello world')
  const b = await computeRevision('hello world!')
  assert.notEqual(a, b)
})

test('computeRevision returns 64-char hex', async () => {
  const r = await computeRevision('test')
  assert.match(r, /^[0-9a-f]{64}$/)
})
