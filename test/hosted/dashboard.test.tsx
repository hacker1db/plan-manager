import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import PlanMarkdown, { markdownBody } from "../../src/components/plan-markdown"
import { diagramImage, mermaidSource } from "../../src/components/mermaid-diagram"
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

test("hosted rendering switches to MDX blocks when frontmatter declares format: mdx", () => {
  const source = '---\nid: private_id\nformat: mdx\n---\n# Recap\n\n<Endpoint method="GET" path="/api/plans/:id" change="modified">\nReturns **format**.\n</Endpoint>\n\n<Tabs>\n<Tab label="a.ts">\n<Diff filename="a.ts" before={"x"} after={"y"} />\n</Tab>\n</Tabs>\n\n{process.env.SECRET}\n'
  const html = renderToStaticMarkup(<PlanMarkdown markdown={source} />)
  assert.match(html, /pm-endpoint/)
  assert.match(html, /<strong>format<\/strong>/)
  assert.match(html, /pm-diff/)
  assert.match(html, /expressions\} are not supported/)
  assert.doesNotMatch(html, /private_id|SECRET/)
  const plain = renderToStaticMarkup(<PlanMarkdown markdown={"---\nid: x\n---\n<Callout>\nhi\n</Callout>"} />)
  assert.doesNotMatch(plain, /pm-callout/)
})

test("mermaid fences render a diagram container with the source as fallback; other code stays a code block", () => {
  const fence = "flowchart LR\n  A[\"Start<br/>here\"] --> B<script>"
  const html = renderToStaticMarkup(<PlanMarkdown markdown={"# Plan\n\n``` mermaid\n" + fence + "\n```\n\n```ts\nconst x = 1\n```\n"} />)
  assert.match(html, /<figure class="mermaid-diagram" data-mermaid="pending"><pre><code class="language-mermaid">flowchart LR/)
  assert.match(html, /B&lt;script&gt;/)
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /<pre><code class="language-ts">const x = 1/)
  const mdx = renderToStaticMarkup(<PlanMarkdown markdown={"---\nformat: mdx\n---\n```mermaid\nflowchart TD\n  A --> B\n```\n"} />)
  assert.match(mdx, /data-mermaid="pending"/)
})

test("mermaidSource only matches code elements tagged language-mermaid", () => {
  const code = (className: unknown) => ({ type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", properties: { className }, children: [{ type: "text", value: "graph TD\n" }] }] })
  assert.equal(mermaidSource(code(["language-mermaid"])), "graph TD\n")
  assert.equal(mermaidSource(code("language-mermaid")), "graph TD\n")
  assert.equal(mermaidSource(code(["language-ts"])), null)
  assert.equal(mermaidSource(undefined), null)
})

test("rendered diagrams are isolated as data: SVG images sized from the viewBox", () => {
  const image = diagramImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 640.5 312"><style>body{display:none}</style></svg>')
  assert.equal(image.width, 641)
  assert.equal(image.height, 312)
  assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
  assert.doesNotMatch(image.src, /<|>/)
  assert.equal(diagramImage("<svg></svg>").width, undefined)
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
  assert.match(libraryScript, /status\.className = 'status-select'/)
  assert.match(libraryScript, /for \(const value of \['active', 'completed', 'archived'\]\)/)
  assert.match(libraryScript, /if \(!hosted\) \{\s+actions\.append\(/)
  assert.match(libraryScript, /setInterval\(\(\) => loadPlans\(\)/)
  assert.match(detailScript, /if \(hosted\) \{[\s\S]*?setInterval\(reconcileHostedRevision, 15000\)/)
  assert.equal(await readFile(resolve(root, "src", "app", "globals.css"), "utf8"), await readFile(resolve(dashboard, "style.css"), "utf8"))
  assert.deepEqual(await readFile(resolve(root, "public", "dashboard-icon.png")), await readFile(resolve(dashboard, "icon.png")))
  await assert.rejects(access(resolve(root, "hosted")), { code: "ENOENT" })
})
