import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import PlanMarkdown, { markdownBody } from "../../src/components/plan-markdown"
import { libraryBody, planBody } from "../../src/components/generated-dashboard"
import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

test("plan rendering hides canonical frontmatter and renders headings, tables, and tasks", () => {
  const source = "---\nid: private_id\ntitle: Plan\n---\n# Project\n\n| Task | State |\n| --- | --- |\n| Auth | Done |\n\n- [x] Completed\n"
  const html = renderToStaticMarkup(<PlanMarkdown markdown={source} />)
  assert.match(html, /<h1>Project<\/h1>/)
  assert.match(html, /<table>/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /disabled/)
  assert.doesNotMatch(html, /private_id/)
  assert.equal(markdownBody("# No metadata"), "# No metadata")
})

test("plan rendering excludes active HTML, unsafe links, and remote image requests", () => {
  const html = renderToStaticMarkup(<PlanMarkdown markdown={'# Safe\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert%281%29)\n\n![Tracker](https://tracker.example/pixel.png)'} />)
  assert.doesNotMatch(html, /<script|javascript:|<img|tracker\.example/)
  assert.match(html, /<h1>Safe<\/h1>/)
})

test("hosted shells and browser assets are generated from the canonical local dashboard", async () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "..")
  const dashboard = resolve(root, "src/dashboard")
  const readBody = async (filename: string) => {
    const source = await readFile(resolve(dashboard, filename), "utf8")
    const start = source.indexOf("<body")
    const openingEnd = source.indexOf(">", start) + 1
    const closingStart = source.lastIndexOf("</body>")
    assert.ok(start >= 0 && openingEnd > 0 && closingStart > openingEnd)
    return source.slice(openingEnd, closingStart).split("\n").filter(line => !line.trim().startsWith("<script")).join("\n").trim()
  }
  assert.equal(libraryBody.trim(), await readBody("index.html"))
  assert.equal(planBody.trim(), await readBody("plan.html"))
  for (const filename of ["app.js", "plan.js"]) {
    assert.equal(await readFile(resolve(root, "public", filename), "utf8"), await readFile(resolve(dashboard, filename), "utf8"))
  }
  const libraryScript = await readFile(resolve(root, "public", "app.js"), "utf8")
  const detailScript = await readFile(resolve(root, "public", "plan.js"), "utf8")
  assert.match(libraryScript, /if \(!hosted\) \{\s+const actions = document\.createElement\('div'\)/)
  assert.match(libraryScript, /setInterval\(\(\) => loadPlans\(\)/)
  assert.match(detailScript, /if \(hosted\) \{[\s\S]*?setInterval\(reconcileHostedRevision, 15000\)/)
  assert.equal(await readFile(resolve(root, "src", "app", "globals.css"), "utf8"), await readFile(resolve(dashboard, "style.css"), "utf8"))
  assert.deepEqual(await readFile(resolve(root, "public", "dashboard-icon.png")), await readFile(resolve(dashboard, "icon.png")))
  await assert.rejects(access(resolve(root, "hosted")), { code: "ENOENT" })
})
