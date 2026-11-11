import assert from "node:assert/strict"
import { test } from "node:test"
import type { HostedPlan, HostedPlanInput } from "../../src/lib/hosted/types"
import { versionObjectKey, writeValidatedPlan, type PlanWriteStore } from "../../src/lib/server/write-plan"

const REV_A = "a".repeat(64)
const REV_B = "b".repeat(64)
const REV_C = "c".repeat(64)

function plan(revision: string): HostedPlan {
  return { id: "plan_write_1", title: "Write", status: "active", tags: [], created: "2026-11-11T00:00:00.000Z", updated: "2026-11-11T00:00:00.000Z", revision, objectKey: versionObjectKey("plan_write_1", revision) }
}

function input(revision: string, expectedRevision: string | null): HostedPlanInput {
  return { id: "plan_write_1", title: "Write", status: "active", tags: [], created: "2026-11-11T00:00:00.000Z", updated: "2026-11-12T00:00:00.000Z", markdown: `# ${revision.slice(0, 1)}\n`, revision, expectedRevision }
}

// In-memory Neon + Blob with the same semantics: put never overwrites, upsert is conditional.
function fakeStore(options: { current?: HostedPlan | null; versions?: Record<string, string>; blobs?: string[]; raceTo?: string } = {}) {
  let current = options.current ?? null
  const versions = new Map(Object.entries(options.versions ?? {}))
  const blobs = new Set(options.blobs ?? [])
  const calls = { put: [] as string[], del: [] as string[] }
  const store: PlanWriteStore = {
    async findPlan() { return current },
    async findVersionKey(_id, revision) { return versions.get(revision) ?? null },
    async blobExists(key) { return blobs.has(key) },
    async putBlob(key) {
      calls.put.push(key)
      if (blobs.has(key)) throw new Error("This blob already exists")
      blobs.add(key)
    },
    async deleteBlob(key) { calls.del.push(key); blobs.delete(key) },
    async upsertPlan(value, objectKey) {
      // Simulates another writer committing between our read and our conditional upsert.
      if (options.raceTo) current = plan(options.raceTo)
      if ((current?.revision ?? null) !== value.expectedRevision) return null
      current = { ...plan(value.revision), objectKey }
      return current
    },
    async recordVersion(_id, revision, objectKey) { if (!versions.has(revision)) versions.set(revision, objectKey) },
  }
  return { store, calls, blobs, versions, get current() { return current } }
}

test("a normal push writes the blob, the plan row and the version", async () => {
  const fake = fakeStore({ current: plan(REV_A), versions: { [REV_A]: versionObjectKey("plan_write_1", REV_A) }, blobs: [versionObjectKey("plan_write_1", REV_A)] })
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, false)
  assert.equal(result.plan.revision, REV_B)
  assert.deepEqual(fake.calls.put, [versionObjectKey("plan_write_1", REV_B)])
  assert.equal(fake.versions.get(REV_B), versionObjectKey("plan_write_1", REV_B))
  assert.deepEqual(fake.calls.del, [])
})

test("losing the conditional-upsert race deletes the blob this call just wrote", async () => {
  const fake = fakeStore({ current: plan(REV_A), raceTo: REV_C })
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, true)
  assert.equal(result.plan.revision, REV_C)
  const newKey = versionObjectKey("plan_write_1", REV_B)
  assert.deepEqual(fake.calls.del, [newKey])
  assert.equal(fake.blobs.has(newKey), false, "no orphaned blob is left behind")
})

test("losing the race never deletes a blob that existed before this call", async () => {
  const existingKey = versionObjectKey("plan_write_1", REV_B)
  const fake = fakeStore({ current: plan(REV_A), blobs: [existingKey], raceTo: REV_C })
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, true)
  assert.deepEqual(fake.calls.put, [])
  assert.deepEqual(fake.calls.del, [])
  assert.equal(fake.blobs.has(existingKey), true)
})

test("losing the race to a push of the same revision is not a conflict and keeps the blob", async () => {
  const fake = fakeStore({ current: plan(REV_A), raceTo: REV_B })
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, false)
  assert.equal(result.plan.revision, REV_B)
  assert.deepEqual(fake.calls.del, [])
})

test("reverting to an earlier revision reuses its blob without calling put", async () => {
  const keyA = versionObjectKey("plan_write_1", REV_A)
  const keyB = versionObjectKey("plan_write_1", REV_B)
  const fake = fakeStore({ current: plan(REV_B), versions: { [REV_A]: keyA, [REV_B]: keyB }, blobs: [keyA, keyB] })
  const result = await writeValidatedPlan(fake.store, input(REV_A, REV_B))
  assert.equal(result.conflict, false)
  assert.equal(result.plan.revision, REV_A)
  assert.equal(result.plan.objectKey, keyA)
  assert.deepEqual(fake.calls.put, [], "the content-addressed blob is reused, not re-uploaded")
  assert.deepEqual(fake.calls.del, [])
})

test("a blob orphaned by an earlier failure is reused instead of failing the push", async () => {
  const orphan = versionObjectKey("plan_write_1", REV_B)
  const fake = fakeStore({ current: plan(REV_A), blobs: [orphan] })
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, false)
  assert.equal(result.plan.objectKey, orphan)
  assert.deepEqual(fake.calls.put, [])
})

test("a concurrent upload that creates the same blob first is treated as reuse", async () => {
  const key = versionObjectKey("plan_write_1", REV_B)
  const fake = fakeStore({ current: plan(REV_A) })
  const base = fake.store.putBlob
  fake.store.putBlob = async (objectKey, markdown) => { fake.blobs.add(objectKey); await base(objectKey, markdown) }
  const result = await writeValidatedPlan(fake.store, input(REV_B, REV_A))
  assert.equal(result.conflict, false)
  assert.equal(result.plan.objectKey, key)
  assert.deepEqual(fake.calls.del, [])
})

test("a database failure after a fresh upload removes the blob; one after the upsert keeps it", async () => {
  const key = versionObjectKey("plan_write_1", REV_B)
  const failing = fakeStore({ current: plan(REV_A) })
  failing.store.upsertPlan = async () => { throw new Error("database unavailable") }
  await assert.rejects(writeValidatedPlan(failing.store, input(REV_B, REV_A)), /database unavailable/)
  assert.deepEqual(failing.calls.del, [key])

  const late = fakeStore({ current: plan(REV_A) })
  late.store.recordVersion = async () => { throw new Error("version insert failed") }
  await assert.rejects(writeValidatedPlan(late.store, input(REV_B, REV_A)), /version insert failed/)
  assert.deepEqual(late.calls.del, [], "the plan row references the blob, so it must survive")
  assert.equal(late.blobs.has(key), true)
})

test("existing revision and stale expectedRevision short-circuit before any storage write", async () => {
  const same = fakeStore({ current: plan(REV_B) })
  assert.equal((await writeValidatedPlan(same.store, input(REV_B, REV_A))).conflict, false)
  const stale = fakeStore({ current: plan(REV_C) })
  assert.equal((await writeValidatedPlan(stale.store, input(REV_B, REV_A))).conflict, true)
  assert.deepEqual([...same.calls.put, ...stale.calls.put, ...same.calls.del, ...stale.calls.del], [])
})
