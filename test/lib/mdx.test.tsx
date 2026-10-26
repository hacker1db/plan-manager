import assert from "node:assert/strict"
import { test } from "node:test"
import { readdir, readFile } from "node:fs/promises"
import { renderToStaticMarkup } from "react-dom/server"
import { BLOCKS, blocksReference, type BlockSpec } from "../../src/lib/mdx/blocks"
import { diffLines, PlanMdx } from "../../src/lib/mdx/render"
import { formatFromPath, sourceFormat, stripFrontmatter } from "../../src/lib/mdx/format"

function render(source: string): string {
  return renderToStaticMarkup(<PlanMdx source={source} />)
}

function problems(source: string): string[] {
  const found: string[] = []
  renderToStaticMarkup(<PlanMdx source={source} problems={found} />)
  return found
}

function wrapped(block: BlockSpec): string {
  return block.parent ? `<${block.parent}>\n${block.example.replace("...", "Body")}\n</${block.parent}>` : block.example
}

test("every catalog example renders without a block error", () => {
  for (const block of BLOCKS) {
    const html = render(wrapped(block))
    assert.doesNotMatch(html, /pm-block-error/, `${block.name}: ${html}`)
    assert.match(html, /pm-block|pm-column|pm-tab-panel/, block.name)
  }
  const reference = blocksReference()
  for (const block of BLOCKS) assert.match(reference, new RegExp(`## <${block.name}>`))
})

test("the Go CLI's embedded block registry matches this one", async () => {
  const embedded = await readFile(new URL("../../cli/internal/mdx/blocks.json", import.meta.url), "utf8")
  assert.equal(embedded, JSON.stringify({ version: 1, blocks: BLOCKS }) + "\n", "regenerate cli/internal/mdx/blocks.json from BLOCKS")
})

test("MDX is parsed, never evaluated: imports, expressions, and unknown tags become error cards", () => {
  const html = render([
    'import fs from "node:fs"',
    "export const x = 1",
    "{globalThis.process.exit(1)}",
    "<Evil onClick={alert(1)} />",
    '<Diff filename="a" before={secret} after="b" />',
    "<Callout title={`hi ${name}`}>x</Callout>",
    '<FileTree files={[{ path: "a", __proto__: { polluted: true } }]} />',
    "<Callout {...props}>\nspread\n</Callout>",
    "<script>alert(1)</script>",
    '<a href="javascript:alert(1)">x</a>',
    "[bad](javascript:alert(1))",
  ].join("\n\n"))
  assert.doesNotMatch(html, /<script|javascript:|onclick/i)
  assert.match(html, /import and export statements are not supported/)
  assert.match(html, /\{expressions\} are not supported/)
  assert.match(html, /Unknown block &lt;Evil&gt;/)
  assert.match(html, /variables are not supported/)
  assert.match(html, /object key &quot;__proto__&quot; is not allowed/)
  assert.match(html, /spread attributes are not supported/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test("validation names missing props, wrong types, bad enums, and misplaced children", () => {
  const html = render([
    '<Diff filename="a.ts" />',
    '<FileTree files="nope" />',
    '<Callout tone="loud">\nx\n</Callout>',
    '<Tab label="orphan">\nx\n</Tab>',
    "<Tabs>\nloose text\n</Tabs>",
    '<ApiEndpoint method="GET" path="/" />',
  ].join("\n\n"))
  assert.match(html, /missing required prop &quot;before&quot;/)
  assert.match(html, /prop &quot;files&quot; must be array, got string/)
  assert.match(html, /prop &quot;tone&quot; must be one of/)
  assert.match(html, /&lt;Tab&gt; is only valid inside &lt;Tabs&gt;/)
  assert.match(html, /&lt;Tabs&gt; may only contain &lt;Tab&gt; elements/)
  assert.match(html, /did you mean &lt;Endpoint&gt;/)
})

test("unparseable MDX falls back to an error card plus the escaped source", () => {
  const html = render("<Callout>\nnever closed <b>")
  assert.match(html, /MDX could not be parsed/)
  assert.match(html, /<pre class="markdown-fallback">&lt;Callout&gt;/)
})

test("task checkboxes keep the dashboard toggle contract", () => {
  const html = render("<Callout>\n- [ ] inside\n</Callout>\n\n- [x] outside")
  assert.equal(html.match(/data-plan-task="true"/g)?.length, 2)
  assert.match(html, /data-plan-task="true" checked=""/)
})

test("tabs render one radio per tab with the first selected", () => {
  const html = render('<Tabs>\n<Tab label="one.ts">\nFirst\n</Tab>\n<Tab label="two.ts">\nSecond\n</Tab>\n</Tabs>')
  assert.equal(html.match(/type="radio"/g)?.length, 2)
  assert.match(html, /<label for="pm-tabs-0-0">one\.ts<\/label><label for="pm-tabs-0-1">two\.ts<\/label>/)
  assert.match(html, /id="pm-tabs-0-0" name="pm-tabs-0" checked=""/)
})

test("diffLines aligns unchanged lines and numbers both sides", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])
  assert.deepEqual(ops.map(op => `${op.kind}:${op.text}`), ["same:a", "del:b", "add:x", "same:c", "same:d", "add:e"])
  assert.deepEqual(ops.at(-1), { kind: "add", text: "e", after: 5 })
  assert.equal(ops.find(op => op.text === "c")?.before, 3)
  const html = render('<Diff filename="x.ts" mode="unified" before={"a\\nb"} after={"a\\nc"} annotations={[{ line: 2, note: "Renamed" }]} />')
  assert.match(html, /pm-del">- b/)
  assert.match(html, /pm-add">\+ c/)
  assert.match(html, /<p>Renamed<\/p>/)
})

test("format detection uses frontmatter for portability and the extension on disk", () => {
  assert.equal(sourceFormat("---\nid: a\nformat: mdx\n---\n# x"), "mdx")
  assert.equal(sourceFormat("---\nformat: 'mdx'\n---\n"), "mdx")
  assert.equal(sourceFormat("# format: mdx"), "md")
  assert.equal(formatFromPath("/p/plan.mdx"), "mdx")
  assert.equal(formatFromPath("/p/plan.md"), "md")
  assert.equal(stripFrontmatter("---\nformat: mdx\n---\n<Callout />"), "<Callout />")
})

test("checked-in MDX docs render without problems", async () => {
  const root = new URL("../../docs/", import.meta.url)
  const docs = (await readdir(root, { recursive: true })).filter(name => name.endsWith(".mdx"))
  assert.ok(docs.length > 0)
  for (const name of docs) {
    const raw = await readFile(new URL(name, root), "utf8")
    assert.equal(sourceFormat(raw), "mdx", `${name} must declare format: mdx`)
    assert.deepEqual(problems(stripFrontmatter(raw)), [], name)
  }
})
