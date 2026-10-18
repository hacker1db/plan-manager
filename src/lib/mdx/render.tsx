import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import { BLOCKS_BY_NAME, CHANGE_VALUES, validateBlockProps, type ChangeKind } from './blocks.ts'
import { staticProps } from './static-props.ts'

// MDX plans are parsed with remark-mdx but never compiled or evaluated. JSX
// elements become placeholder hast nodes that map onto the whitelisted block
// components below; props must be static literals (see static-props.ts).

type Props = Record<string, unknown>

interface BlockRecord {
  index: number
  name: string
  props: Props
  inline: boolean
  parent: string | null
  parentIndex: number | null
  error?: string
  tabs?: string[]
}

const INLINE_HTML = new Set(['abbr', 'b', 'br', 'code', 'em', 'i', 'kbd', 'mark', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u'])
const FLOW_HTML = new Set([...INLINE_HTML, 'details', 'div', 'hr', 'p', 'summary'])
const ALIASES: Record<string, string> = {
  ApiEndpoint: 'Endpoint',
  Diagram: 'Flow or Layers',
  FileMap: 'FileTree',
  Mermaid: 'Flow or Layers',
  QuestionForm: 'Questions',
  RichText: 'plain Markdown',
  TabsBlock: 'Tabs',
}

function unknownBlockMessage(name: string): string {
  const match = [...BLOCKS_BY_NAME.keys()].find(known => known.toLowerCase() === name.toLowerCase()) ?? ALIASES[name]
  return `Unknown block <${name}>${match ? ` — did you mean ${match.includes(' ') ? match : `<${match}>`}?` : ''}`
}

function createHandlers(records: BlockRecord[]) {
  const stack: BlockRecord[] = []

  function placeholder(record: BlockRecord, children: unknown[]) {
    return { type: 'element', tagName: 'plan-block', properties: { dataBlock: String(record.index) }, children }
  }

  function failure(state: any, node: any, inline: boolean, message: string) {
    const record: BlockRecord = { index: records.length, name: '', props: {}, inline, parent: null, parentIndex: null, error: message }
    records.push(record)
    const result = placeholder(record, [])
    state.patch(node, result)
    return result
  }

  function jsx(state: any, node: any, flow: boolean) {
    const name: string | null = node.name
    if (name === null) return state.all(node)
    if (/^[a-z]/.test(name)) {
      if (!(flow ? FLOW_HTML : INLINE_HTML).has(name)) return state.all(node)
      const result = { type: 'element', tagName: name, properties: {}, children: state.all(node) }
      state.patch(node, result)
      return result
    }
    const record: BlockRecord = { index: records.length, name, props: {}, inline: !flow, parent: stack.at(-1)?.name ?? null, parentIndex: stack.at(-1)?.index ?? null }
    records.push(record)
    const spec = BLOCKS_BY_NAME.get(name)
    if (!spec) {
      record.error = unknownBlockMessage(name)
    } else if (!flow) {
      record.error = `<${name}> is a block: put its opening and closing tags on their own lines`
    } else if (spec.parent && record.parent !== spec.parent) {
      record.error = `<${name}> is only valid inside <${spec.parent}>`
    } else {
      try {
        record.props = staticProps(node.attributes)
        const problems = validateBlockProps(spec, record.props)
        if (problems.length) record.error = `<${name}>: ${problems.join('; ')}`
      } catch (error) {
        record.error = `<${name}>: ${(error as Error).message}`
      }
    }
    if (!record.error && spec && spec.children !== 'markdown' && spec.children !== 'none') {
      const stray = node.children.find((child: any) => child.type !== 'mdxJsxFlowElement' || child.name !== spec.children)
      if (stray) record.error = `<${name}> may only contain <${spec.children}> elements`
    }
    stack.push(record)
    const children = record.error ? [] : state.all(node)
    stack.pop()
    if (name === 'Tabs') {
      record.tabs = records
        .filter(child => child.parentIndex === record.index && child.name === 'Tab')
        .map(child => String(child.props.label ?? ''))
    }
    const result = placeholder(record, children)
    state.patch(node, result)
    return result
  }

  return {
    mdxJsxFlowElement: (state: any, node: any) => jsx(state, node, true),
    mdxJsxTextElement: (state: any, node: any) => jsx(state, node, false),
    mdxjsEsm: (state: any, node: any) => failure(state, node, false, 'import and export statements are not supported in plans'),
    mdxFlowExpression: (state: any, node: any) => failure(state, node, false, '{expressions} are not supported in plans; escape braces as \\{ or use a code span'),
    mdxTextExpression: (state: any, node: any) => failure(state, node, true, '{expressions} are not supported in plans'),
  }
}

// ---------- shared helpers ----------

function asRecord(value: unknown): Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Props : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function isChange(value: unknown): value is ChangeKind {
  return (CHANGE_VALUES as readonly unknown[]).includes(value)
}

function ChangeBadge({ change }: { change: unknown }) {
  return isChange(change) ? <span className={`pm-change pm-change-${change}`}>{change}</span> : null
}

function BlockTitle({ title, summary }: { title?: unknown; summary?: unknown }) {
  if (!title && !summary) return null
  return <header className="pm-block-head">
    {title ? <h4 className="pm-block-title">{text(title)}</h4> : null}
    {summary ? <p className="pm-block-summary">{text(summary)}</p> : null}
  </header>
}

function BlockError({ message, inline }: { message: string; inline: boolean }) {
  return inline
    ? <span className="pm-block-error" role="note">{message}</span>
    : <div className="pm-block-error" role="note"><strong>Plan block error</strong><span>{message}</span></div>
}

function splitLines(value: unknown): string[] {
  const source = text(value).replace(/\r\n/g, '\n')
  return source === '' ? [] : source.replace(/\n$/, '').split('\n')
}

function prettyJson(value: unknown): string {
  const source = text(value)
  try { return JSON.stringify(JSON.parse(source), null, 2) } catch { return source }
}

interface Annotation { line: number; note: string; side: 'before' | 'after' }

function annotations(value: unknown): Annotation[] {
  return asArray(value).map(asRecord)
    .filter(item => Number.isInteger(item.line) && item.note)
    .map(item => ({ line: item.line as number, note: text(item.note), side: item.side === 'before' ? 'before' : 'after' }))
}

function notesFor(list: Annotation[], side: 'before' | 'after', line: number | undefined): Annotation[] {
  return line === undefined ? [] : list.filter(item => item.side === side && item.line === line)
}

// ---------- line diff ----------

interface DiffOp { kind: 'same' | 'del' | 'add'; text: string; before?: number; after?: number }

export function diffLines(before: string[], after: string[]): DiffOp[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  const a = before.slice(start, endBefore)
  const b = after.slice(start, endAfter)
  const middle: DiffOp[] = []
  if (a.length * b.length > 4_000_000) {
    middle.push(...a.map(line => ({ kind: 'del' as const, text: line })), ...b.map(line => ({ kind: 'add' as const, text: line })))
  } else {
    const width = b.length + 1
    const table = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { middle.push({ kind: 'same', text: a[i] }); i++; j++ }
      else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { middle.push({ kind: 'del', text: a[i] }); i++ }
      else { middle.push({ kind: 'add', text: b[j] }); j++ }
    }
  }
  const ops: DiffOp[] = [
    ...before.slice(0, start).map(line => ({ kind: 'same' as const, text: line })),
    ...middle,
    ...before.slice(endBefore).map(line => ({ kind: 'same' as const, text: line })),
  ]
  let beforeLine = 0
  let afterLine = 0
  for (const op of ops) {
    if (op.kind !== 'add') op.before = ++beforeLine
    if (op.kind !== 'del') op.after = ++afterLine
  }
  return ops
}

function NoteRow({ notes, span }: { notes: Annotation[]; span: number }) {
  if (notes.length === 0) return null
  return <tr className="pm-note-row"><td colSpan={span}>{notes.map((item, index) => <p key={index}>{item.note}</p>)}</td></tr>
}

function Diff(props: Props) {
  const ops = diffLines(splitLines(props.before), splitLines(props.after))
  const notes = annotations(props.annotations)
  const split = props.mode !== 'unified'
  const added = ops.filter(op => op.kind === 'add').length
  const removed = ops.filter(op => op.kind === 'del').length
  const rows: ReactNode[] = []
  if (split) {
    for (let index = 0; index < ops.length;) {
      if (ops[index].kind === 'same') {
        const op = ops[index++]
        rows.push(<tr key={rows.length}><td className="pm-ln">{op.before}</td><td className="pm-code">{op.text}</td><td className="pm-ln">{op.after}</td><td className="pm-code">{op.text}</td></tr>)
        rows.push(<NoteRow key={rows.length} span={4} notes={[...notesFor(notes, 'before', op.before), ...notesFor(notes, 'after', op.after)]} />)
        continue
      }
      const dels: DiffOp[] = []
      const adds: DiffOp[] = []
      while (index < ops.length && ops[index].kind !== 'same') (ops[index].kind === 'del' ? dels : adds).push(ops[index++])
      for (let row = 0; row < Math.max(dels.length, adds.length); row++) {
        const left = dels[row]
        const right = adds[row]
        rows.push(<tr key={rows.length}>
          <td className="pm-ln">{left?.before}</td><td className={left ? 'pm-code pm-del' : 'pm-code pm-empty'}>{left?.text}</td>
          <td className="pm-ln">{right?.after}</td><td className={right ? 'pm-code pm-add' : 'pm-code pm-empty'}>{right?.text}</td>
        </tr>)
        rows.push(<NoteRow key={rows.length} span={4} notes={[...notesFor(notes, 'before', left?.before), ...notesFor(notes, 'after', right?.after)]} />)
      }
    }
  } else {
    for (const op of ops) {
      const marker = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '
      rows.push(<tr key={rows.length}><td className="pm-ln">{op.before}</td><td className="pm-ln">{op.after}</td><td className={`pm-code pm-${op.kind}`}>{marker} {op.text}</td></tr>)
      rows.push(<NoteRow key={rows.length} span={3} notes={[...(op.kind === 'del' ? notesFor(notes, 'before', op.before) : []), ...(op.kind !== 'del' ? notesFor(notes, 'after', op.after) : [])]} />)
    }
  }
  return <figure className="pm-block pm-code-block pm-diff">
    <figcaption className="pm-code-head">
      <code>{text(props.filename)}</code>
      {props.language ? <span className="pm-lang">{text(props.language)}</span> : null}
      <span className="pm-stats"><span className="pm-plus">+{added}</span> <span className="pm-minus">−{removed}</span></span>
    </figcaption>
    {props.summary ? <p className="pm-block-summary">{text(props.summary)}</p> : null}
    <div className="pm-scroll"><table className={split ? 'pm-diff-table pm-split' : 'pm-diff-table pm-unified'}><tbody>{rows}</tbody></table></div>
  </figure>
}

function AnnotatedCode(props: Props) {
  const notes = annotations(props.annotations)
  const rows: ReactNode[] = []
  splitLines(props.code).forEach((line, index) => {
    const notesHere = notesFor(notes, 'after', index + 1)
    rows.push(<tr key={rows.length} className={notesHere.length ? 'pm-noted' : undefined}><td className="pm-ln">{index + 1}</td><td className="pm-code">{line}</td></tr>)
    rows.push(<NoteRow key={rows.length} span={2} notes={notesHere} />)
  })
  return <figure className="pm-block pm-code-block pm-annotated">
    <figcaption className="pm-code-head">
      <code>{text(props.filename)}</code>
      {props.language ? <span className="pm-lang">{text(props.language)}</span> : null}
    </figcaption>
    {props.summary ? <p className="pm-block-summary">{text(props.summary)}</p> : null}
    <div className="pm-scroll"><table className="pm-diff-table"><tbody>{rows}</tbody></table></div>
  </figure>
}

// ---------- structure blocks ----------

interface TreeDir { name: string; dirs: Map<string, TreeDir>; files: Props[] }

function buildTree(files: Props[]): TreeDir {
  const root: TreeDir = { name: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = text(file.path).split('/').filter(Boolean)
    let current = root
    for (const part of parts.slice(0, -1)) {
      if (!current.dirs.has(part)) current.dirs.set(part, { name: part, dirs: new Map(), files: [] })
      current = current.dirs.get(part)!
    }
    current.files.push({ ...file, name: parts.at(-1) ?? text(file.path) })
  }
  return root
}

function TreeNodes({ dir }: { dir: TreeDir }) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
  return <ul>
    {dirs.map(child => {
      let node = child
      let label = child.name
      while (node.files.length === 0 && node.dirs.size === 1) {
        node = [...node.dirs.values()][0]
        label += `/${node.name}`
      }
      return <li key={label} className="pm-tree-dir"><span className="pm-tree-name">{label}/</span><TreeNodes dir={node} /></li>
    })}
    {dir.files.map((file, index) => <li key={index} className="pm-tree-file">
      <span className="pm-tree-name">{text(file.name)}</span>
      <ChangeBadge change={file.change} />
      {Number.isFinite(file.additions) || Number.isFinite(file.deletions)
        ? <span className="pm-stats">{Number.isFinite(file.additions) ? <span className="pm-plus">+{text(file.additions)}</span> : null} {Number.isFinite(file.deletions) ? <span className="pm-minus">−{text(file.deletions)}</span> : null}</span>
        : null}
      {file.note ? <span className="pm-tree-note">{text(file.note)}</span> : null}
    </li>)}
  </ul>
}

function FileTree(props: Props) {
  const files = asArray(props.files).map(asRecord)
  const sum = (key: string) => files.reduce((total, file) => total + (Number.isFinite(file[key]) ? file[key] as number : 0), 0)
  return <section className="pm-block pm-tree">
    <header className="pm-block-head">
      <h4 className="pm-block-title">{text(props.title ?? 'Changed files')}</h4>
      <p className="pm-block-summary">{files.length} file{files.length === 1 ? '' : 's'} · <span className="pm-plus">+{sum('additions')}</span> <span className="pm-minus">−{sum('deletions')}</span></p>
    </header>
    <TreeNodes dir={buildTree(files)} />
  </section>
}

function DataModel(props: Props) {
  const relations = asArray(props.relations).map(asRecord)
  return <section className="pm-block pm-model">
    <BlockTitle title={props.title} />
    <div className="pm-model-grid">
      {asArray(props.entities).map(asRecord).map((entity, index) => <article key={index} className={`pm-entity${isChange(entity.change) ? ` pm-entity-${entity.change}` : ''}`}>
        <header><strong>{text(entity.name)}</strong><ChangeBadge change={entity.change} /></header>
        {entity.note ? <p className="pm-entity-note">{text(entity.note)}</p> : null}
        <table><tbody>
          {asArray(entity.fields).map(asRecord).map((field, fieldIndex) => <tr key={fieldIndex} className={isChange(field.change) ? `pm-field-${field.change}` : undefined}>
            <td className="pm-field-name">{field.key ? <span className="pm-key">{text(field.key)}</span> : null}{text(field.name)}</td>
            <td className="pm-field-type">{field.was ? <><del>{text(field.was)}</del> → </> : null}<code>{text(field.type)}</code></td>
            <td><ChangeBadge change={field.change} />{field.note ? <span className="pm-field-note">{text(field.note)}</span> : null}</td>
          </tr>)}
        </tbody></table>
      </article>)}
    </div>
    {relations.length ? <ul className="pm-relations">{relations.map((relation, index) => <li key={index}><code>{text(relation.from)}</code> → <code>{text(relation.to)}</code>{relation.label ? ` ${text(relation.label)}` : ''}</li>)}</ul> : null}
  </section>
}

function Endpoint(props: Props, children: ReactNode) {
  const params = asArray(props.params).map(asRecord)
  const request = asRecord(props.request)
  const responses = asArray(props.responses).map(asRecord)
  const method = text(props.method)
  return <section className={`pm-block pm-endpoint${props.deprecated ? ' pm-deprecated' : ''}`}>
    <header className="pm-endpoint-head">
      <span className={`pm-method pm-method-${method.toLowerCase()}`}>{method}</span>
      <code className="pm-path">{text(props.path)}</code>
      <ChangeBadge change={props.change} />
      {props.deprecated ? <span className="pm-change pm-change-removed">deprecated</span> : null}
    </header>
    {children ? <div className="pm-endpoint-body">{children}</div> : null}
    {params.length ? <table className="pm-params"><thead><tr><th>Param</th><th>In</th><th>Type</th><th>Notes</th></tr></thead><tbody>
      {params.map((param, index) => <tr key={index}>
        <td><code>{text(param.name)}</code>{param.required ? <span className="pm-required">required</span> : null}</td>
        <td>{text(param.in)}</td>
        <td>{param.was ? <><del>{text(param.was)}</del> → </> : null}<code>{text(param.type)}</code></td>
        <td><ChangeBadge change={param.change} />{text(param.note)}</td>
      </tr>)}
    </tbody></table> : null}
    {request.example !== undefined ? <div className="pm-example"><span className="pm-example-label">Request{request.contentType ? ` · ${text(request.contentType)}` : ''}</span><pre><code>{prettyJson(request.example)}</code></pre></div> : null}
    {responses.map((response, index) => <div key={index} className="pm-example">
      <span className="pm-example-label"><span className={`pm-status pm-status-${text(response.status).charAt(0)}xx`}>{text(response.status)}</span> {text(response.description)} <ChangeBadge change={response.change} /></span>
      {response.example !== undefined ? <pre><code>{prettyJson(response.example)}</code></pre> : null}
    </div>)}
  </section>
}

function Flow(props: Props) {
  return <section className="pm-block pm-flow-block">
    <BlockTitle title={props.title} />
    <ol className={`pm-flow pm-flow-${props.direction === 'vertical' ? 'vertical' : 'horizontal'}`}>
      {asArray(props.steps).map(asRecord).map((step, index) => <li key={index} className="pm-flow-step">
        <span className="pm-flow-label"><strong>{text(step.label)}</strong><ChangeBadge change={step.change} /></span>
        {step.detail ? <span>{text(step.detail)}</span> : null}
      </li>)}
    </ol>
  </section>
}

function Layers(props: Props) {
  return <section className="pm-block pm-layers">
    <BlockTitle title={props.title} />
    {asArray(props.layers).map(asRecord).map((layer, index) => <div key={index} className="pm-layer">
      <div className="pm-layer-label"><strong>{text(layer.label)}</strong>{layer.note ? <span>{text(layer.note)}</span> : null}</div>
      <ul className="pm-layer-items">
        {asArray(layer.items).map((item, itemIndex) => {
          const value = typeof item === 'string' ? { label: item } : asRecord(item)
          return <li key={itemIndex} className={isChange(value.change) ? `pm-item-${value.change}` : undefined} title={value.note ? text(value.note) : undefined}>
            {text(value.label)}<ChangeBadge change={value.change} />
          </li>
        })}
      </ul>
    </div>)}
  </section>
}

function Questions(props: Props) {
  return <section className="pm-block pm-questions">
    <BlockTitle title={props.title ?? 'Open questions'} />
    <ol>
      {asArray(props.items).map(asRecord).map((item, index) => <li key={index}>
        <p className="pm-question">{text(item.question)}</p>
        {item.recommendation ? <p className="pm-recommendation"><span>Recommended</span> {text(item.recommendation)}</p> : null}
        {asArray(item.options).length ? <ul className="pm-options">{asArray(item.options).map((option, optionIndex) => <li key={optionIndex}>{text(option)}</li>)}</ul> : null}
      </li>)}
    </ol>
  </section>
}

function Tabs(record: BlockRecord, children: ReactNode) {
  const panels = Children.toArray(children).filter(isValidElement)
  const labels = record.tabs ?? []
  const group = `pm-tabs-${record.index}`
  return <section className="pm-block pm-tabs">
    <BlockTitle title={record.props.title} />
    {labels.map((_, index) => <input key={index} className="pm-tab-input" type="radio" name={group} id={`${group}-${index}`} defaultChecked={index === 0} />)}
    <div className="pm-tab-list">{labels.map((label, index) => <label key={index} htmlFor={`${group}-${index}`}>{label}</label>)}</div>
    <div className="pm-tab-panels">{panels}</div>
  </section>
}

function renderBlock(record: BlockRecord, children: ReactNode): ReactElement | null {
  if (record.error) return <BlockError message={record.error} inline={record.inline} />
  const props = record.props
  try {
    switch (record.name) {
      case 'Callout': {
        const tone = typeof props.tone === 'string' ? props.tone : 'note'
        return <aside className={`pm-block pm-callout pm-tone-${tone}`}>
          <p className="pm-callout-title">{text(props.title ?? tone)}</p>
          {children}
        </aside>
      }
      case 'Columns': return <section className="pm-block pm-columns-block"><BlockTitle title={props.title} /><div className="pm-columns">{children}</div></section>
      case 'Column': return <div className="pm-column">{props.label ? <p className="pm-column-label">{text(props.label)}</p> : null}{children}</div>
      case 'Tabs': return Tabs(record, children)
      case 'Tab': return <div className="pm-tab-panel">{children}</div>
      case 'FileTree': return FileTree(props)
      case 'Diff': return Diff(props)
      case 'AnnotatedCode': return AnnotatedCode(props)
      case 'DataModel': return DataModel(props)
      case 'Endpoint': return Endpoint(props, children)
      case 'Flow': return Flow(props)
      case 'Layers': return Layers(props)
      case 'Questions': return Questions(props)
      default: return <BlockError message={unknownBlockMessage(record.name)} inline={record.inline} />
    }
  } catch (error) {
    return <BlockError message={`<${record.name}> could not render: ${(error as Error).message}`} inline={record.inline} />
  }
}

export function PlanMdx({ source, problems }: { source: string; problems?: string[] }) {
  const records: BlockRecord[] = []
  const components = {
    'plan-block': ({ children, ...rest }: { children?: ReactNode; 'data-block'?: string }) => {
      const record = records[Number(rest['data-block'])]
      if (record?.error) problems?.push(record.error)
      return record ? renderBlock(record, children) : null
    },
    input: ({ type, checked }: { type?: string; checked?: boolean }) => type === 'checkbox'
      ? <input type="checkbox" defaultChecked={Boolean(checked)} disabled data-plan-task="true" />
      : null,
    img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  } as unknown as Components
  try {
    return Markdown({
      children: source,
      remarkPlugins: [remarkMdx, remarkGfm],
      remarkRehypeOptions: { handlers: createHandlers(records) as never },
      components,
    })
  } catch (error) {
    problems?.push(`MDX could not be parsed: ${(error as Error).message}`)
    return <>
      <BlockError message={`MDX could not be parsed: ${(error as Error).message}`} inline={false} />
      <pre className="markdown-fallback">{source}</pre>
    </>
  }
}
