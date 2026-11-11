import type { HostedPlan, HostedPlanInput } from "../hosted/types.ts"

// The storage steps writePlan needs, injected so the write sequence can be tested without
// Neon or Vercel Blob. src/lib/server/store.ts provides the real implementations.
export type PlanWriteStore = {
  findPlan(id: string): Promise<HostedPlan | null>
  // object_key of a recorded (plan_id, revision) version, if any.
  findVersionKey(id: string, revision: string): Promise<string | null>
  blobExists(objectKey: string): Promise<boolean>
  // Private, no overwrite. Rejects if the pathname already exists.
  putBlob(objectKey: string, markdown: string): Promise<void>
  deleteBlob(objectKey: string): Promise<void>
  // Conditional upsert (WHERE plans.revision = expectedRevision); null when it lost the race.
  upsertPlan(input: HostedPlanInput, objectKey: string): Promise<HostedPlan | null>
  recordVersion(id: string, revision: string, objectKey: string): Promise<void>
}

export function versionObjectKey(id: string, revision: string): string {
  return `plans/${id}/${revision}.md`
}

// Blob keys are content-addressed: `revision` has already been verified to be the SHA-256 of
// `markdown` (plan-input.ts), so an existing blob at that key holds exactly these bytes and can be
// reused. Returns the key and whether this call created the blob (only then may it delete it).
async function storeBlob(store: PlanWriteStore, input: HostedPlanInput): Promise<{ objectKey: string; created: boolean }> {
  const known = await store.findVersionKey(input.id, input.revision)
  if (known) return { objectKey: known, created: false }
  const objectKey = versionObjectKey(input.id, input.revision)
  if (await store.blobExists(objectKey)) return { objectKey, created: false }
  try {
    await store.putBlob(objectKey, input.markdown)
    return { objectKey, created: true }
  } catch (error) {
    // A concurrent upload of the same revision created it first; same key, same bytes.
    if (await store.blobExists(objectKey).catch(() => false)) return { objectKey, created: false }
    throw error
  }
}

async function discardBlob(store: PlanWriteStore, objectKey: string): Promise<void> {
  await store.deleteBlob(objectKey).catch(() => undefined)
}

// `input` must already be validated (validatePlanUpload).
export async function writeValidatedPlan(store: PlanWriteStore, input: HostedPlanInput): Promise<{ plan: HostedPlan; conflict: boolean }> {
  const existing = await store.findPlan(input.id)
  if (existing?.revision === input.revision) return { plan: existing, conflict: false }
  if ((existing?.revision ?? null) !== input.expectedRevision) return { plan: existing ?? null as never, conflict: true }

  const { objectKey, created } = await storeBlob(store, input)
  let plan: HostedPlan | null
  try {
    plan = await store.upsertPlan(input, objectKey)
  } catch (error) {
    if (created) await discardBlob(store, objectKey)
    throw error
  }
  if (!plan) {
    // Lost the race. A concurrent push of this same revision may have won with the same blob,
    // so keep it while anything references it; otherwise remove the blob this call wrote.
    const current = await store.findPlan(input.id)
    if (current?.revision === input.revision) return { plan: current, conflict: false }
    if (created && !await store.findVersionKey(input.id, input.revision)) await discardBlob(store, objectKey)
    return { plan: current ?? null as never, conflict: true }
  }
  // The plan row now references the blob, so it is never deleted past this point.
  await store.recordVersion(input.id, input.revision, objectKey)
  return { plan, conflict: false }
}
