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
