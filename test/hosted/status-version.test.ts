import assert from "node:assert/strict"
import { test } from "node:test"
import yaml from "js-yaml"
import { createStatusVersion } from "../../src/hosted/lib/status-version"
import { computeRevision } from "../../src/lib/ids"

test("status changes create a new revision while preserving the Markdown body and metadata", async () => {
  const source = "---\nid: plan_1234\ntitle: Plan\nstatus: active\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\ntags:\n  - work\nsource: imported\n---\n\n# Keep this body\n\n- [ ] Task\n"
  const nextBody = "\n# Keep this body\n\n- [ ] Task\n"
  const updated = "2026-02-01T12:00:00.000Z"
  for (const status of ["active", "completed", "archived"] as const) {
    const result = await createStatusVersion(source, {
      id: "plan_1234",
      title: "Plan",
      created: "2026-01-01T00:00:00.000Z",
      tags: ["work"],
    }, status, updated)
    const end = result.markdown.indexOf("\n---", 3)
    const metadata = yaml.load(result.markdown.slice(3, end).trim()) as Record<string, unknown>
    assert.equal(metadata.status, status)
    assert.equal(metadata.source, "imported")
    assert.equal(metadata.updated, updated)
    assert.equal(result.markdown.slice(end + 4).replace(/^\n/, ""), nextBody)
    assert.equal(result.revision, await computeRevision(result.markdown))
  }
})
