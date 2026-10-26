import assert from "node:assert/strict"
import { test } from "node:test"
import { computeRevision, generateId, slugify } from "../../src/lib/ids"

test("generateId returns unique 21-character IDs", () => {
  const id = generateId()
  assert.equal(typeof id, "string")
  assert.equal(id.length, 21)
  assert.notEqual(generateId(), id)
})

test("slugify lowercases, trims dashes, and falls back to plan", () => {
  assert.equal(slugify("My Plan! 2024"), "my-plan-2024")
  assert.equal(slugify("  hello world  "), "hello-world")
  assert.equal(slugify("!!!"), "plan")
})

test("computeRevision is a deterministic sha256 hex digest", async () => {
  assert.equal(await computeRevision("hello world"), await computeRevision("hello world"))
  assert.notEqual(await computeRevision("hello world"), await computeRevision("hello world!"))
  assert.match(await computeRevision("test"), /^[0-9a-f]{64}$/)
})
