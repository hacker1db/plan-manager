import type { ComponentProps, ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { sourceFormat, stripFrontmatter } from "../mdx/format.ts"
import { PlanMdx } from "../mdx/render.tsx"

// Server-only plan renderer for the hosted viewer. It reuses the exact renderers the
// Next.js app shipped: react-markdown + GFM with raw HTML skipped for Markdown, and the
// restricted (never evaluated) MDX block renderer shared with the CLI/local dashboard.
// Output is static, escaped markup; the browser only upgrades mermaid placeholders.

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

export function markdownBody(markdown: string): string {
  return stripFrontmatter(markdown)
}

export function mermaidSource(node: HastNode | undefined): string | null {
  const code = node?.children?.find(child => child.type === "element" && child.tagName === "code")
  if (!code) return null
  const className = code.properties?.className
  const classes = Array.isArray(className) ? className.map(String) : typeof className === "string" ? className.split(/\s+/) : []
  if (!classes.includes("language-mermaid")) return null
  return (code.children ?? []).map(child => child.value ?? "").join("")
}

// Fenced ```mermaid blocks become a pending diagram figure holding the source as a code
// block; src/lib/hosted/mermaid.ts renders them in the browser. Other code stays a code block.
export function PlanPre({ node, children, ...rest }: ComponentProps<"pre"> & { node?: HastNode; children?: ReactNode }) {
  const source = mermaidSource(node)
  if (source === null) return <pre {...rest}>{children}</pre>
  return <figure className="mermaid-diagram" data-mermaid="pending"><pre><code className="language-mermaid">{source}</code></pre></figure>
}

export function PlanMarkdown({ markdown }: { markdown: string }) {
  if (sourceFormat(markdown) === "mdx") return <article className="markdown-body"><PlanMdx source={markdownBody(markdown)} components={{ pre: PlanPre }} /></article>
  return <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, pre: PlanPre }}>{markdownBody(markdown)}</ReactMarkdown></article>
}

export function renderPlanHtml(markdown: string): string {
  return renderToStaticMarkup(<PlanMarkdown markdown={markdown} />)
}
