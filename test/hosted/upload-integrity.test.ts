import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { HostedPlanInput } from "../../src/lib/hosted/types"
import { validatePlanUpload } from "../../src/lib/server/plan-input"
import { ValidationError } from "../../src/lib/server/sanitize"
import { createStatusVersion } from "../../src/lib/server/status-version"

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

const MARKDOWN = `---
id: plan_upload_1
title: Upload integrity
status: active
created: "2026-11-11T19:07:20.492Z"
updated: "2026-11-11T19:07:20.492Z"
tags:
  - security
  - hosted
---

# Upload integrity
`

function upload(overrides: Partial<HostedPlanInput> = {}): HostedPlanInput {
  const markdown = overrides.markdown ?? MARKDOWN
  return {
    id: "plan_upload_1",
    title: "Upload integrity",
    status: "active",
    tags: ["security", "hosted"],
    created: "2026-11-11T19:07:20.492Z",
    updated: "2026-11-11T19:07:20.492Z",
    markdown,
    revision: sha256(markdown.replace(/\r\n/g, "\n")),
    expectedRevision: null,
    ...overrides,
  }
}

const rejects = (input: HostedPlanInput, pattern: RegExp) =>
  assert.rejects(validatePlanUpload(input), (error: unknown) => error instanceof ValidationError && pattern.test(error.message))

test("an upload whose revision is the SHA-256 of its Markdown is accepted", async () => {
  const normalized = await validatePlanUpload(upload())
  assert.equal(normalized.revision, sha256(MARKDOWN))
  assert.equal(normalized.markdown, MARKDOWN)
})

test("an upload whose revision is not sha256(markdown) is rejected", async () => {
  await rejects(upload({ revision: "a".repeat(64) }), /Revision does not match/)
  await rejects(upload({ revision: sha256(`${MARKDOWN}tampered`) }), /Revision does not match/)
})

test("the revision covers the stored (LF-normalized) bytes, matching the Go CLI", async () => {
  const crlf = MARKDOWN.replace(/\n/g, "\r\n")
  // The CLI hashes the LF-normalized bytes it sends; the server stores exactly those.
  const normalized = await validatePlanUpload(upload({ markdown: crlf, revision: sha256(MARKDOWN) }))
  assert.equal(normalized.markdown, MARKDOWN)
  // Hashing the raw CRLF file (the old CLI behaviour) no longer matches what is stored.
  await rejects(upload({ markdown: crlf, revision: sha256(crlf) }), /Revision does not match/)
})

test("metadata that disagrees with the frontmatter is rejected, naming only the fields", async () => {
  await rejects(upload({ title: "Something else" }), /: title$/)
  await rejects(upload({ status: "completed" }), /: status$/)
  await rejects(upload({ tags: ["security"] }), /: tags$/)
  await rejects(upload({ tags: ["hosted", "security"] }), /: tags$/)
  await rejects(upload({ created: "2020-01-01T00:00:00.000Z" }), /: created$/)
  await rejects(upload({ title: "Other", status: "archived" }), /: title, status$/)
  await assert.rejects(validatePlanUpload(upload({ title: "Something else" })), (error: unknown) => error instanceof Error && !error.message.includes("Something else"))
})

test("a frontmatter id that differs from the upload id is rejected", async () => {
  const markdown = MARKDOWN.replace("id: plan_upload_1", "id: plan_other_9")
  await rejects(upload({ markdown }), /: id$/)
})

test("absent frontmatter fields must match the CLI defaults", async () => {
  const bare = "# No frontmatter\n"
  await validatePlanUpload(upload({ markdown: bare, title: "Untitled", status: "active", tags: [] }))
  await rejects(upload({ markdown: bare, title: "Claimed title", status: "active", tags: [] }), /: title$/)
  await rejects(upload({ markdown: bare, title: "Untitled", status: "archived", tags: [] }), /: status$/)
  await rejects(upload({ markdown: bare, title: "Untitled", status: "active", tags: ["x"] }), /: tags$/)
  // An unknown frontmatter status falls back to "active", as in the CLI.
  const odd = MARKDOWN.replace("status: active", "status: in-progress")
  await validatePlanUpload(upload({ markdown: odd }))
})

test("unquoted YAML timestamps and padded titles compare like the CLI sends them", async () => {
  const markdown = MARKDOWN.replace('created: "2026-11-11T19:07:20.492Z"', "created: 2026-11-11T19:07:20.492Z").replace("title: Upload integrity", 'title: "  Upload integrity  "')
  await validatePlanUpload(upload({ markdown }))
})

test("hosted status changes still produce uploads the validator accepts", async () => {
  const plan = { id: "plan_upload_1", title: "Upload integrity", created: "2026-11-11T19:07:20.492Z", tags: ["security", "hosted"] }
  const updated = "2026-11-12T08:00:00.000Z"
  const { markdown, revision } = await createStatusVersion(MARKDOWN, plan, "completed", updated)
  await validatePlanUpload(upload({ markdown, revision, status: "completed", updated, expectedRevision: sha256(MARKDOWN) }))
})
