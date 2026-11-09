import assert from "node:assert/strict"
import {test} from "node:test"
import {changeMobileStatus, statusAvailability, statusInput} from "../../src/lib/server/mobile.ts"
import {createStatusVersion} from "../../src/lib/server/status-version.ts"
import type {HostedPlan} from "../../src/lib/hosted/types.ts"

const initial: HostedPlan = {id: "plan_1234", title: "Plan", status: "active", tags: [], created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", revision: "a".repeat(64), objectKey: "private"}
test("native status rejects stale revisions before reading or writing content", async () => {
  const result = await changeMobileStatus(initial.id, {status: "completed", expectedRevision: "b".repeat(64)}, {find: async () => initial, read: async () => {throw Error("must not read")}, version: createStatusVersion, write: async () => {throw Error("must not write")}})
  assert.equal(result.status, 409)
})
test("native status preserves lifecycle gates and fails closed on malformed metadata", () => {
  assert.ok(statusAvailability("---\ntracking: {}\n---\nbody"))
  assert.ok(statusAvailability("---\nx: [\n---\nbody"))
  assert.equal(statusAvailability("# Plain plan"), null)
  assert.equal(statusInput({status: "completed"}), null)
  assert.equal(statusInput({status: "unknown", expectedRevision: "a".repeat(64)}), null)
})
test("two clients cannot silently overwrite and a refreshed no-op does not write", async () => {
  let current = initial
  let writes = 0
  const dependencies = {find: async () => current, read: async () => "# Body", version: createStatusVersion, write: async (input: any) => {
    if (input.expectedRevision !== current.revision) return {plan: current, conflict: true}
    writes++; current = {...current, ...input}; return {plan: current, conflict: false}
  }}
  const first = await changeMobileStatus(initial.id, {status: "completed", expectedRevision: initial.revision}, dependencies)
  assert.equal(first.status, 200)
  assert.equal((await changeMobileStatus(initial.id, {status: "archived", expectedRevision: initial.revision}, dependencies)).status, 409)
  assert.equal((await changeMobileStatus(initial.id, {status: "completed", expectedRevision: current.revision}, dependencies)).status, 200)
  assert.equal(writes, 1)
})

 test("pagination is opt-in and bounded, with status filters", async () => {
  const {pagePlans} = await import("../../src/lib/server/mobile.ts")
  const plans = [initial, {...initial, id: "plan_5678", status: "completed" as const}]
  assert.equal(pagePlans(plans, new URL("https://example.test")).plans.length, 2)
  assert.equal(pagePlans(plans, new URL("https://example.test?limit=1")).nextOffset, 1)
  assert.equal(pagePlans(plans, new URL("https://example.test?limit=1&offset=1")).nextOffset, null)
  assert.equal(pagePlans(plans, new URL("https://example.test?status=completed")).plans[0].id, "plan_5678")
  assert.throws(() => pagePlans(plans, new URL("https://example.test?limit=101")), RangeError)
})

test("rendered headings have deterministic anchors without executing MDX or raw HTML", async () => {
  const {mobileDocument, resolveAnchor} = await import("../../src/lib/server/mobile-document.ts")
  const original = mobileDocument("# Root\n\n## Review\n\nKeep context\n<script>alert(1)</script>")
  assert.equal(original.headings.length, 2)
  assert.doesNotMatch(original.html, /<script/)
  assert.deepEqual(original, mobileDocument("# Root\n\n## Review\n\nKeep context\n<script>alert(1)</script>"))
  assert.equal(resolveAnchor(original.headings[1], []), null)
  const duplicate = mobileDocument("# Root\n\n## Review\n\nKeep context\n\n## Review\n\nKeep context")
  assert.equal(resolveAnchor(duplicate.headings[1], duplicate.headings), null)
  assert.notEqual(duplicate.headings[1].id, duplicate.headings[2].id)
})
