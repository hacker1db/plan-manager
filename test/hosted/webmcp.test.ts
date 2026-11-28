import assert from "node:assert/strict"
import { test } from "node:test"
import {
  INPUT_SCHEMA,
  MAX_STEPS,
  OUTPUT_SCHEMA,
  SUMMARY_LIMIT,
  TOOL_NAME,
  ToolError,
  createPlanTool,
  detectModelContext,
  parsePlanRecord,
  summarizeMarkdown,
  type Fetcher,
  type PlanTool,
} from "../../src/dashboard/webmcp.js"

// Synthetic, non-secret fixture. Mirrors the local server's /api/plans/:id shape, including the
// fields the tool must drop (filePath, source, comments, html, tags).
const FIXTURE_MARKDOWN = `---
id: fixture_plan_01
title: Fixture plan
status: active
---
# Fixture plan

Ship the **preview** behind a [flag](https://example.invalid/flag).
Second line of the same paragraph.

## Tasks

- [x] Write the fixture
- [ ] Register the tool
- [ ] Verify cleanup on \`pagehide\`

\`\`\`md
- [ ] not a task inside a fence
\`\`\`

<!-- private reviewer note: do not expose -->
`

const LOCAL_RESPONSE = {
  id: "fixture_plan_01",
  title: "Fixture plan",
  status: "active",
  created: "2026-11-01T00:00:00.000Z",
  updated: "2026-11-02T00:00:00.000Z",
  tags: ["internal-tag"],
  revision: "a".repeat(64),
  format: "markdown",
  body: FIXTURE_MARKDOWN,
  html: "<p>rendered</p>",
  comments: [{ line: 3, text: "private comment" }],
  filePath: "/Users/example/plans/fixture.md",
  source: "/Users/example/source.html",
  url: "/plans/fixture_plan_01",
}

const EXPECTED = {
  id: "fixture_plan_01",
  title: "Fixture plan",
  status: "active",
  updated: "2026-11-02T00:00:00.000Z",
  revision: "a".repeat(64),
  source: { environment: "local", path: "/plans/fixture_plan_01" },
  summary: "Ship the preview behind a flag. Second line of the same paragraph.",
  nextSteps: ["Register the tool", "Verify cleanup on pagehide"],
  openTaskCount: 2,
  completedTaskCount: 1,
} as const

interface Call { path: string; init: RequestInit }

function fakeFetch(status: number, body: unknown): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: Fetcher = async (path, init) => {
    calls.push({ path, init })
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }
  return { fetcher, calls }
}

function tool(fetcher: Fetcher, onDenied: () => void = () => {}): PlanTool {
  return createPlanTool({ planId: "fixture_plan_01", environment: "local", fetcher, onDenied })
}

test("schemas are valid JSON Schema objects and the output schema covers exactly the returned keys", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(INPUT_SCHEMA)), { type: "object", properties: {}, additionalProperties: false })
  const properties = Object.keys(OUTPUT_SCHEMA.properties).sort()
  assert.deepEqual([...(OUTPUT_SCHEMA.required ?? [])].sort(), properties)
  assert.deepEqual(Object.keys(EXPECTED).sort(), properties)
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false)
})

test("tool descriptor is read-only and matches the draft spec dictionary", () => {
  const descriptor = tool(fakeFetch(200, LOCAL_RESPONSE).fetcher)
  assert.equal(descriptor.name, TOOL_NAME)
  assert.ok(descriptor.description.length > 0)
  assert.deepEqual(descriptor.annotations, { readOnlyHint: true, untrustedContentHint: true })
  assert.equal(typeof descriptor.execute, "function")
})

test("execute returns only the allowlisted summary fields from a same-origin GET", async () => {
  const { fetcher, calls } = fakeFetch(200, LOCAL_RESPONSE)
  const result = await tool(fetcher).execute({}, { signal: new AbortController().signal })
  assert.deepEqual(result, EXPECTED)
  const serialized = JSON.stringify(result)
  for (const secret of ["filePath", "/Users/example", "private comment", "private reviewer note", "internal-tag", "rendered", "example.invalid", "not a task"]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`)
  }
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call?.path, "/api/plans/fixture_plan_01")
  assert.equal(call?.init.method, undefined)
  assert.equal(call?.init.credentials, "same-origin")
  assert.equal(call?.init.body, undefined)
})

test("hosted responses (markdown field) map to the same contract", async () => {
  const { body, filePath, source, ...rest } = LOCAL_RESPONSE
  void filePath; void source
  const hosted = createPlanTool({ planId: "fixture_plan_01", environment: "hosted", fetcher: fakeFetch(200, { ...rest, markdown: body }).fetcher, onDenied: () => {} })
  const result = await hosted.execute({})
  assert.deepEqual(result, { ...EXPECTED, source: { environment: "hosted", path: "/plans/fixture_plan_01" } })
})

for (const status of [401, 403, 404]) {
  test(`execute fails closed and revokes on ${status}`, async () => {
    let denied = 0
    await assert.rejects(tool(fakeFetch(status, { error: "no" }).fetcher, () => { denied += 1 }).execute({}), ToolError)
    assert.equal(denied, 1)
  })
}

test("execute rejects malformed or mismatched responses", async () => {
  await assert.rejects(tool(fakeFetch(200, { ...LOCAL_RESPONSE, id: "other_plan" }).fetcher).execute({}), /Unexpected plan response/)
  await assert.rejects(tool(fakeFetch(200, ["not", "a", "plan"]).fetcher).execute({}), /Unexpected plan response/)
  await assert.rejects(tool(fakeFetch(500, {}).fetcher).execute({}), /failed with 500/)
  assert.equal(parsePlanRecord({ ...LOCAL_RESPONSE, revision: 7 }), null)
})

test("summaries are bounded", () => {
  const long = `${"word ".repeat(200)}\n\n${Array.from({ length: 9 }, (_, index) => `- [ ] step ${index} ${"x".repeat(300)}`).join("\n")}`
  const result = summarizeMarkdown(long)
  assert.ok(result.summary.length <= SUMMARY_LIMIT)
  assert.equal(result.nextSteps.length, MAX_STEPS)
  assert.equal(result.openTaskCount, 9)
  assert.ok(result.nextSteps.every(step => step.length <= 160))
})

test("feature detection prefers document.modelContext, falls back to navigator, and rejects partial shapes", async () => {
  const seen: string[] = []
  const documentHost = { modelContext: { registerTool: (descriptor: PlanTool) => { seen.push(`document:${descriptor.name}`) } } }
  const navigatorHost = { modelContext: { registerTool: (descriptor: PlanTool) => { seen.push(`navigator:${descriptor.name}`) } } }
  const descriptor = tool(fakeFetch(200, LOCAL_RESPONSE).fetcher)
  await detectModelContext(documentHost, navigatorHost)?.registerTool(descriptor, { signal: new AbortController().signal })
  await detectModelContext({ modelContext: null }, navigatorHost)?.registerTool(descriptor, { signal: new AbortController().signal })
  assert.deepEqual(seen, [`document:${TOOL_NAME}`, `navigator:${TOOL_NAME}`])
  assert.equal(detectModelContext({ modelContext: null }, { modelContext: null }), null)
  assert.equal(detectModelContext({ modelContext: { provideContext: () => {} } }, null), null)
  assert.equal(detectModelContext(null, null), null)
})
