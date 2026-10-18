// Block vocabulary for MDX plans. This registry is the single source of truth
// for the renderer's validation and for `plan blocks`, so the catalog an agent
// reads can never drift from what the dashboards actually render.

export type PropType = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface PropSpec {
  type: PropType
  required?: boolean
  values?: readonly string[]
  doc: string
}

export interface BlockSpec {
  name: string
  summary: string
  children: 'markdown' | 'none' | string
  parent?: string
  props: Record<string, PropSpec>
  example: string
}

export const CHANGE_VALUES = ['added', 'modified', 'removed', 'renamed'] as const
export type ChangeKind = typeof CHANGE_VALUES[number]

const change: PropSpec = { type: 'string', values: CHANGE_VALUES, doc: 'Diff-aware flag rendered as a badge' }
const title: PropSpec = { type: 'string', doc: 'Heading shown above the block' }
const summary: PropSpec = { type: 'string', doc: 'One-line description shown under the title' }

export const BLOCKS: readonly BlockSpec[] = [
  {
    name: 'Callout',
    summary: 'Highlighted note for a decision, risk, warning, or outcome.',
    children: 'markdown',
    props: {
      tone: { type: 'string', values: ['note', 'info', 'decision', 'warning', 'risk', 'success'], doc: 'Visual tone; defaults to note' },
      title,
    },
    example: '<Callout tone="decision" title="Store MDX next to Markdown">\nPlans keep YAML frontmatter; only the body syntax changes.\n</Callout>',
  },
  {
    name: 'Columns',
    summary: 'Side-by-side container for structured comparisons such as Before / After.',
    children: 'Column',
    props: { title },
    example: '<Columns>\n<Column label="Before">\nPandoc renders Markdown only.\n</Column>\n<Column label="After">\nMDX plans render typed blocks.\n</Column>\n</Columns>',
  },
  {
    name: 'Column',
    summary: 'One column inside Columns.',
    children: 'markdown',
    parent: 'Columns',
    props: { label: { type: 'string', doc: 'Column heading, e.g. Before or After' } },
    example: '<Column label="After">\n...\n</Column>',
  },
  {
    name: 'Tabs',
    summary: 'Horizontal tabs; use under a "## Key changes" heading to group Diff blocks.',
    children: 'Tab',
    props: { title },
    example: '<Tabs>\n<Tab label="storage.ts">\n<Diff filename="src/lib/storage.ts" before={"a"} after={"b"} />\n</Tab>\n</Tabs>',
  },
  {
    name: 'Tab',
    summary: 'One panel inside Tabs.',
    children: 'markdown',
    parent: 'Tabs',
    props: { label: { type: 'string', required: true, doc: 'Tab label, usually a file basename' } },
    example: '<Tab label="render.tsx">\n...\n</Tab>',
  },
  {
    name: 'FileTree',
    summary: 'Footprint of the change: files grouped by directory with change flags and stats.',
    children: 'none',
    props: {
      title,
      files: { type: 'array', required: true, doc: '[{ path, change?, note?, additions?, deletions? }]' },
    },
    example: '<FileTree files={[{ path: "src/lib/mdx/render.tsx", change: "added", note: "MDX renderer", additions: 420 }, { path: "src/lib/storage.ts", change: "modified", additions: 12, deletions: 4 }]} />',
  },
  {
    name: 'Diff',
    summary: 'Literal before/after code with optional line annotations. Split mode by default.',
    children: 'none',
    props: {
      filename: { type: 'string', required: true, doc: 'Path shown in the header' },
      language: { type: 'string', doc: 'Language label' },
      before: { type: 'string', required: true, doc: 'Old text; use a JSON string such as {"line 1\\nline 2"}' },
      after: { type: 'string', required: true, doc: 'New text' },
      mode: { type: 'string', values: ['split', 'unified'], doc: 'Defaults to split' },
      summary,
      annotations: { type: 'array', doc: '[{ line, note, side?: "before" | "after" }] — line numbers default to the after side' },
    },
    example: '<Diff filename="src/lib/storage.ts" summary="List .mdx plans alongside .md" before={"if (!name.endsWith(\'.md\')) continue"} after={"if (!isPlanFilename(name)) continue"} annotations={[{ line: 1, note: "Accepts .md and .mdx" }]} />',
  },
  {
    name: 'AnnotatedCode',
    summary: 'A new file or added block, with notes pinned to the lines that matter.',
    children: 'none',
    props: {
      filename: { type: 'string', required: true, doc: 'Path shown in the header' },
      language: { type: 'string', doc: 'Language label' },
      code: { type: 'string', required: true, doc: 'Source text as a JSON string' },
      summary,
      annotations: { type: 'array', doc: '[{ line, note }]' },
    },
    example: '<AnnotatedCode filename="src/lib/mdx/format.ts" code={"export function isMdx(meta) {\\n  return meta.format === \'mdx\'\\n}"} annotations={[{ line: 2, note: "Frontmatter is the portable signal" }]} />',
  },
  {
    name: 'DataModel',
    summary: 'Entities, fields, and relations, with per-field change flags and prior types.',
    children: 'none',
    props: {
      title,
      entities: { type: 'array', required: true, doc: '[{ name, change?, note?, fields: [{ name, type, key?: "pk" | "fk", change?, was?, note? }] }]' },
      relations: { type: 'array', doc: '[{ from, to, label? }]' },
    },
    example: '<DataModel entities={[{ name: "PlanMetadata", fields: [{ name: "id", type: "string", key: "pk" }, { name: "format", type: "\\"md\\" | \\"mdx\\"", change: "added" }] }]} />',
  },
  {
    name: 'Endpoint',
    summary: 'HTTP contract after the change. Children are the prose description.',
    children: 'markdown',
    props: {
      method: { type: 'string', required: true, values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], doc: 'HTTP method' },
      path: { type: 'string', required: true, doc: 'Route path' },
      change,
      deprecated: { type: 'boolean', doc: 'Marks a removed or retired route' },
      params: { type: 'array', doc: '[{ name, in: "path" | "query" | "header" | "body", type, required?, change?, was?, note? }]' },
      request: { type: 'object', doc: '{ contentType?, example? } — example is a single JSON value as a string' },
      responses: { type: 'array', doc: '[{ status, description?, example?, change? }]' },
    },
    example: '<Endpoint method="GET" path="/api/plans/:id" responses={[{ status: 200, example: "{\\"format\\":\\"mdx\\"}" }]}>\nReturns rendered HTML for Markdown and MDX plans.\n</Endpoint>',
  },
  {
    name: 'Flow',
    summary: 'Ordered steps with arrows, for genuinely sequential mechanics.',
    children: 'none',
    props: {
      title,
      direction: { type: 'string', values: ['horizontal', 'vertical'], doc: 'Defaults to horizontal' },
      steps: { type: 'array', required: true, doc: '[{ label, detail?, change? }]' },
    },
    example: '<Flow steps={[{ label: "plan.mdx", detail: "frontmatter + MDX" }, { label: "remark-mdx", detail: "parse, never eval" }, { label: "React", detail: "whitelisted blocks" }]} />',
  },
  {
    name: 'Layers',
    summary: 'Stacked groups (layers, regions, ownership boundaries) for architecture.',
    children: 'none',
    props: {
      title,
      layers: { type: 'array', required: true, doc: '[{ label, note?, items: [string | { label, change?, note? }] }]' },
    },
    example: '<Layers layers={[{ label: "Surfaces", items: ["Local dashboard", "Hosted app"] }, { label: "Renderer", items: [{ label: "src/lib/mdx", change: "added" }] }]} />',
  },
  {
    name: 'Questions',
    summary: 'The single bottom block of open questions, each with a recommended default.',
    children: 'none',
    props: {
      title,
      items: { type: 'array', required: true, doc: '[{ question, recommendation?, options?: string[] }]' },
    },
    example: '<Questions items={[{ question: "Render Mermaid?", recommendation: "Defer; needs client JS", options: ["Defer", "Bundle mermaid"] }]} />',
  },
]

export const BLOCKS_BY_NAME: ReadonlyMap<string, BlockSpec> = new Map(BLOCKS.map(block => [block.name, block]))

function typeOf(value: unknown): PropType | 'null' | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const kind = typeof value
  return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'object' || kind === 'undefined'
    ? kind
    : 'object'
}

export function validateBlockProps(spec: BlockSpec, props: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const [name, prop] of Object.entries(spec.props)) {
    const value = props[name]
    if (value === undefined) {
      if (prop.required) problems.push(`missing required prop "${name}"`)
      continue
    }
    const actual = typeOf(value)
    if (actual !== prop.type) {
      problems.push(`prop "${name}" must be ${prop.type}, got ${actual}`)
      continue
    }
    if (prop.values && !prop.values.includes(String(value))) {
      problems.push(`prop "${name}" must be one of ${prop.values.join(', ')}`)
    }
  }
  for (const name of Object.keys(props)) {
    if (!(name in spec.props) && name !== 'id') problems.push(`unknown prop "${name}"`)
  }
  return problems
}

export function blocksReference(): string {
  const lines = [
    '# MDX plan blocks',
    '',
    'Capitalized tags below are the only block components an MDX plan may use. Props are static',
    'literals: strings, numbers, booleans, arrays, and objects. Expressions, imports, exports, and',
    'unknown components render as an error card instead of running. Every block also accepts `id`.',
    '',
  ]
  for (const block of BLOCKS) {
    lines.push(`## <${block.name}>`, '', block.summary, '')
    if (block.parent) lines.push(`Only valid inside <${block.parent}>.`, '')
    lines.push(`Children: ${block.children === 'markdown' ? 'Markdown' : block.children === 'none' ? 'none (self-closing)' : `<${block.children}> elements`}`, '')
    const props = Object.entries(block.props)
    if (props.length) {
      lines.push('| Prop | Type | Required | Notes |', '| --- | --- | --- | --- |')
      for (const [name, prop] of props) {
        const type = prop.values ? prop.values.map(value => `"${value}"`).join(' \\| ') : prop.type
        lines.push(`| ${name} | ${type} | ${prop.required ? 'yes' : ''} | ${prop.doc.replaceAll('|', '\\|')} |`)
      }
      lines.push('')
    }
    lines.push('```mdx', block.example, '```', '')
  }
  return lines.join('\n')
}
