import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { after } from "node:test"
import { PlanMarkdown, markdownBody, mermaidSource, renderPlanHtml } from "../../src/lib/server/plan-markdown"
import { diagramImage } from "../../src/lib/hosted/mermaid"
import { libraryBody, planBody } from "../../src/lib/hosted/generated-dashboard"
import { hostedShell } from "../../src/lib/hosted/shell"
import { requestStatusChange } from "../../src/lib/hosted/status"
import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { closeViteServer, load } from "./vite-ssr"

after(closeViteServer)

async function renderSvelte(path: string, props: Record<string, unknown>): Promise<string> {
  const { default: Component } = await load(path)
  const { render } = await load("svelte/server")
  return render(Component, { props }).body.replace(/<!--[^>]*-->/g, "")
}

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
    assert.equal(await readFile(resolve(root, "static", filename), "utf8"), await readFile(resolve(dashboard, filename), "utf8"))
  }
  const libraryScript = await readFile(resolve(root, "static", "app.js"), "utf8")
  const detailScript = await readFile(resolve(root, "static", "plan.js"), "utf8")
  assert.match(libraryScript, /status\.className = 'status-select'/)
  assert.match(libraryScript, /for \(const value of \['active', 'completed', 'archived'\]\)/)
  assert.match(libraryScript, /if \(!hosted\) \{\s+actions\.append\(/)
  assert.match(libraryScript, /setInterval\(\(\) => loadPlans\(\)/)
  assert.match(detailScript, /if \(hosted\) \{[\s\S]*?setInterval\(reconcileHostedRevision, 15000\)/)
  assert.equal(await readFile(resolve(root, "src", "app.css"), "utf8"), await readFile(resolve(dashboard, "style.css"), "utf8"))
  assert.deepEqual(await readFile(resolve(root, "static", "dashboard-icon.png")), await readFile(resolve(dashboard, "icon.png")))
  await assert.rejects(access(resolve(root, "hosted")), { code: "ENOENT" })
})

test("hosted plan toolbar offers status changes and archive like the local dashboard", async () => {
  const component = "/src/lib/components/HostedPlanContent.svelte"
  const plan = { id: "abc", title: "Plan", status: "active" as const, tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", revision: "0123456789" }
  const html = await renderSvelte(component, { plan, markdown: "# Plan", html: renderPlanHtml("# Plan") })
  assert.match(html, /<select class="status-select" aria-label="Plan status"/)
  for (const status of ["active", "completed", "archived"]) assert.match(html, new RegExp(`<option value="${status}"`))
  assert.match(html, /<option value="active" selected[^>]*>active<\/option>/)
  assert.doesNotMatch(html, /<option value="completed" selected/)
  assert.match(html, /Copy Markdown/)
  assert.match(html, /href="\/api\/v1\/plans\/abc\/content"[^>]*>Download Markdown/)
  assert.match(html, /class="btn danger"[^>]*>Archive</)
  assert.match(html, /<div class="document"><article class="markdown-body"><h1>Plan<\/h1><\/article>/)
  const archived = await renderSvelte(component, { plan: { ...plan, status: "archived" }, markdown: "# Plan", html: "" })
  assert.doesNotMatch(archived, />Archive</)
  const mdx = await renderSvelte(component, { plan, markdown: "---\nformat: mdx\n---\n# Plan", html: "" })
  assert.match(mdx, /Copy MDX/)
  assert.match(mdx, /Download MDX/)
  const hostile = await renderSvelte(component, { plan: { ...plan, title: "<img src=x onerror=alert(1)>", tags: ["<b>t</b>"] }, markdown: "# Plan", html: "" })
  assert.doesNotMatch(hostile, /<img src=x|<b>t<\/b>/)
})

test("hosted status changes post to the owner status route and surface API errors", async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  const ok = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response("{}", { status: 200 }) }) as typeof fetch
  await requestStatusChange("a/b", "completed", ok)
  assert.equal(calls[0][0], "/api/plans/a%2Fb/status")
  assert.equal(calls[0][1]?.method, "POST")
  assert.equal(calls[0][1]?.body, JSON.stringify({ status: "completed" }))
  const conflict = (async () => new Response(JSON.stringify({ error: "Plan changed concurrently" }), { status: 409 })) as typeof fetch
  await assert.rejects(requestStatusChange("a", "archived", conflict), /Plan changed concurrently/)
  const broken = (async () => new Response("nope", { status: 500 })) as typeof fetch
  await assert.rejects(requestStatusChange("a", "archived", broken), /Request failed with 500/)
})

test("hosted library and plan pages embed the canonical shell with the hosted marker and escaped revision", async () => {
  const component = "/src/lib/components/SharedDashboard.svelte"
  const library = await renderSvelte(component, { view: { kind: "library" } })
  assert.ok(library.includes(hostedShell(libraryBody)))
  assert.doesNotMatch(library, /data-dashboard-environment="local"/)
  const plan = { id: "abc", title: "Plan", status: "active" as const, tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", revision: '"><script>x</script>' }
  const detail = await renderSvelte(component, { view: { kind: "plan", plan, markdown: "# Plan", html: "" } })
  assert.match(detail, /<div id="detail" data-revision="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;">/)
  assert.doesNotMatch(detail, /<script>x/)
  assert.match(library, /<form method="post" action="\/sign-out">/)
  assert.equal(hostedShell(planBody, "rev").replace(' data-revision="rev"', "").replace(/<form method="post" action="\/sign-out">[\s\S]*?<\/form>/, ""), planBody.replaceAll('data-dashboard-environment="local"', 'data-dashboard-environment="hosted"'))
})

test("plan markup is rendered on the server and the client bundle never imports the React renderer", async () => {
  assert.match(renderPlanHtml("# Title\n\n```mermaid\ngraph TD\n```"), /<h1>Title<\/h1>[\s\S]*data-mermaid="pending"/)
  const content = await readFile(resolve(fileURLToPath(new URL("../..", import.meta.url)), "src/lib/components/HostedPlanContent.svelte"), "utf8")
  const imports = content.match(/^\s*import .*$/gm) ?? []
  assert.ok(imports.length > 0)
  for (const line of imports) assert.doesNotMatch(line, /react|plan-markdown|[$#]lib\/server/)
})
