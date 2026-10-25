"use client"

import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react"
import type { Mermaid } from "mermaid"

// Fenced ```mermaid blocks render as diagrams on the hosted viewer. The server
// markup (and the local dashboard's static HTML) keeps the source as a code
// block; mermaid is loaded only in the browser, only when a diagram is present.

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

export function mermaidSource(node: HastNode | undefined): string | null {
  const code = node?.children?.find(child => child.type === "element" && child.tagName === "code")
  if (!code) return null
  const className = code.properties?.className
  const classes = Array.isArray(className) ? className.map(String) : typeof className === "string" ? className.split(/\s+/) : []
  if (!classes.includes("language-mermaid")) return null
  return (code.children ?? []).map(child => child.value ?? "").join("")
}

let configured: Promise<Mermaid> | null = null

function loadMermaid(): Promise<Mermaid> {
  configured ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // strict: labels are sanitized and click handlers are disabled.
      securityLevel: "strict",
      suppressErrorRendering: true,
      // SVG <text> labels instead of HTML in <foreignObject>, so DOMPurify keeps them.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      fontFamily: '"Avenir Next", Avenir, "Gill Sans", "Trebuchet MS", system-ui, sans-serif',
      themeVariables: {
        darkMode: true,
        background: "#11171e",
        primaryColor: "#16202a",
        primaryTextColor: "#e9f2f7",
        primaryBorderColor: "#04d1f9",
        secondaryColor: "#1b2530",
        tertiaryColor: "#0d1116",
        lineColor: "#8fa1b2",
        textColor: "#e9f2f7",
        clusterBkg: "#0d1116",
        clusterBorder: "#2b3846",
        edgeLabelBackground: "#11171e",
      },
    })
    return mermaid
  })
  return configured
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    loadMermaid()
      .then(mermaid => Promise.all([mermaid.render(id, source), import("dompurify")]))
      .then(([result, { default: DOMPurify }]) => {
        // Defense in depth on top of securityLevel strict: plans may hold pasted text.
        const clean = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
        if (!cancelled) setSvg(clean)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [id, source])
  if (svg) return <figure className="mermaid-diagram" data-mermaid="rendered" dangerouslySetInnerHTML={{ __html: svg }} />
  return <figure className="mermaid-diagram" data-mermaid={error ? "error" : "pending"}>
    {error ? <div className="pm-block-error" role="note"><strong>Mermaid diagram could not render</strong><span>{error}</span></div> : null}
    <pre><code className="language-mermaid">{source}</code></pre>
  </figure>
}

// react-markdown `pre` override: mermaid fences become diagrams, everything
// else renders as an ordinary code block.
export function PlanPre({ node, children, ...rest }: ComponentProps<"pre"> & { node?: HastNode; children?: ReactNode }) {
  const source = mermaidSource(node)
  if (source === null) return <pre {...rest}>{children}</pre>
  return <MermaidDiagram source={source} />
}
