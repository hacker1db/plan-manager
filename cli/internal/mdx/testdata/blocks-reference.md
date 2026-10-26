# MDX plan blocks

Capitalized tags below are the only block components an MDX plan may use. Props are static
literals: strings, numbers, booleans, arrays, and objects. Expressions, imports, exports, and
unknown components render as an error card instead of running. Every block also accepts `id`.

## <Callout>

Highlighted note for a decision, risk, warning, or outcome.

Children: Markdown

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| tone | "note" \| "info" \| "decision" \| "warning" \| "risk" \| "success" |  | Visual tone; defaults to note |
| title | string |  | Heading shown above the block |

```mdx
<Callout tone="decision" title="Store MDX next to Markdown">
Plans keep YAML frontmatter; only the body syntax changes.
</Callout>
```

## <Columns>

Side-by-side container for structured comparisons such as Before / After.

Children: <Column> elements

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |

```mdx
<Columns>
<Column label="Before">
Pandoc renders Markdown only.
</Column>
<Column label="After">
MDX plans render typed blocks.
</Column>
</Columns>
```

## <Column>

One column inside Columns.

Only valid inside <Columns>.

Children: Markdown

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| label | string |  | Column heading, e.g. Before or After |

```mdx
<Column label="After">
...
</Column>
```

## <Tabs>

Horizontal tabs; use under a "## Key changes" heading to group Diff blocks.

Children: <Tab> elements

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |

```mdx
<Tabs>
<Tab label="storage.ts">
<Diff filename="src/lib/storage.ts" before={"a"} after={"b"} />
</Tab>
</Tabs>
```

## <Tab>

One panel inside Tabs.

Only valid inside <Tabs>.

Children: Markdown

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| label | string | yes | Tab label, usually a file basename |

```mdx
<Tab label="render.tsx">
...
</Tab>
```

## <FileTree>

Footprint of the change: files grouped by directory with change flags and stats.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |
| files | array | yes | [{ path, change?, note?, additions?, deletions? }] |

```mdx
<FileTree files={[{ path: "src/lib/mdx/render.tsx", change: "added", note: "MDX renderer", additions: 420 }, { path: "src/lib/storage.ts", change: "modified", additions: 12, deletions: 4 }]} />
```

## <Diff>

Literal before/after code with optional line annotations. Split mode by default.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| filename | string | yes | Path shown in the header |
| language | string |  | Language label |
| before | string | yes | Old text; use a JSON string such as {"line 1\nline 2"} |
| after | string | yes | New text |
| mode | "split" \| "unified" |  | Defaults to split |
| summary | string |  | One-line description shown under the title |
| annotations | array |  | [{ line, note, side?: "before" \| "after" }] — line numbers default to the after side |

```mdx
<Diff filename="src/lib/storage.ts" summary="List .mdx plans alongside .md" before={"if (!name.endsWith('.md')) continue"} after={"if (!isPlanFilename(name)) continue"} annotations={[{ line: 1, note: "Accepts .md and .mdx" }]} />
```

## <AnnotatedCode>

A new file or added block, with notes pinned to the lines that matter.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| filename | string | yes | Path shown in the header |
| language | string |  | Language label |
| code | string | yes | Source text as a JSON string |
| summary | string |  | One-line description shown under the title |
| annotations | array |  | [{ line, note }] |

```mdx
<AnnotatedCode filename="src/lib/mdx/format.ts" code={"export function isMdx(meta) {\n  return meta.format === 'mdx'\n}"} annotations={[{ line: 2, note: "Frontmatter is the portable signal" }]} />
```

## <DataModel>

Entities, fields, and relations, with per-field change flags and prior types.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |
| entities | array | yes | [{ name, change?, note?, fields: [{ name, type, key?: "pk" \| "fk", change?, was?, note? }] }] |
| relations | array |  | [{ from, to, label? }] |

```mdx
<DataModel entities={[{ name: "PlanMetadata", fields: [{ name: "id", type: "string", key: "pk" }, { name: "format", type: "\"md\" | \"mdx\"", change: "added" }] }]} />
```

## <Endpoint>

HTTP contract after the change. Children are the prose description.

Children: Markdown

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| method | "GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE" \| "HEAD" \| "OPTIONS" | yes | HTTP method |
| path | string | yes | Route path |
| change | "added" \| "modified" \| "removed" \| "renamed" |  | Diff-aware flag rendered as a badge |
| deprecated | boolean |  | Marks a removed or retired route |
| params | array |  | [{ name, in: "path" \| "query" \| "header" \| "body", type, required?, change?, was?, note? }] |
| request | object |  | { contentType?, example? } — example is a single JSON value as a string |
| responses | array |  | [{ status, description?, example?, change? }] |

```mdx
<Endpoint method="GET" path="/api/plans/:id" responses={[{ status: 200, example: "{\"format\":\"mdx\"}" }]}>
Returns rendered HTML for Markdown and MDX plans.
</Endpoint>
```

## <Flow>

Ordered steps with arrows, for genuinely sequential mechanics.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |
| direction | "horizontal" \| "vertical" |  | Defaults to horizontal |
| steps | array | yes | [{ label, detail?, change? }] |

```mdx
<Flow steps={[{ label: "plan.mdx", detail: "frontmatter + MDX" }, { label: "remark-mdx", detail: "parse, never eval" }, { label: "React", detail: "whitelisted blocks" }]} />
```

## <Layers>

Stacked groups (layers, regions, ownership boundaries) for architecture.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |
| layers | array | yes | [{ label, note?, items: [string \| { label, change?, note? }] }] |

```mdx
<Layers layers={[{ label: "Surfaces", items: ["Local dashboard", "Hosted app"] }, { label: "Renderer", items: [{ label: "src/lib/mdx", change: "added" }] }]} />
```

## <Questions>

The single bottom block of open questions, each with a recommended default.

Children: none (self-closing)

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| title | string |  | Heading shown above the block |
| items | array | yes | [{ question, recommendation?, options?: string[] }] |

```mdx
<Questions items={[{ question: "Render Mermaid?", recommendation: "Defer; needs client JS", options: ["Defer", "Bundle mermaid"] }]} />
```
