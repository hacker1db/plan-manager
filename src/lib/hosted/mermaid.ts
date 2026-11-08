import type { Mermaid } from "mermaid"

// Browser-only. Pending mermaid figures from the server renderer become diagrams.
// mermaid is loaded only when a diagram is present. The SVG is shown through
// <img src="data:...">: an SVG image cannot run script, fetch remote resources, or leak
// its <style> (or classDef/style CSS) into the page.

let configured: Promise<Mermaid> | null = null

function loadMermaid(): Promise<Mermaid> {
  configured ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // strict: labels are sanitized and click handlers are disabled.
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Keep %%{init}%% directives from swapping in their own CSS or theme.
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "theme", "themeCSS", "themeVariables", "fontFamily", "htmlLabels"],
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

export interface DiagramImage { src: string; width?: number; height?: number }

export function diagramImage(svg: string): DiagramImage {
  const box = /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(svg)
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: box ? Math.ceil(Number(box[1])) : undefined,
    height: box ? Math.ceil(Number(box[2])) : undefined,
  }
}

export async function renderMermaid(id: string, source: string): Promise<DiagramImage> {
  const [mermaid, { default: DOMPurify }] = await Promise.all([loadMermaid(), import("dompurify")])
  const result = await mermaid.render(id, source)
  // Defense in depth on top of securityLevel strict: plans may hold pasted text.
  return diagramImage(DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }))
}

function sourceBlock(document: Document, source: string): HTMLPreElement {
  const pre = document.createElement("pre")
  const code = document.createElement("code")
  code.className = "language-mermaid"
  code.textContent = source
  pre.append(code)
  return pre
}

export function showDiagram(figure: HTMLElement, source: string, image: DiagramImage): void {
  const document = figure.ownerDocument
  const img = document.createElement("img")
  img.src = image.src
  if (image.width !== undefined) img.width = image.width
  if (image.height !== undefined) img.height = image.height
  img.alt = "Mermaid diagram; source below"
  const details = document.createElement("details")
  const summary = document.createElement("summary")
  summary.textContent = "Diagram source"
  details.append(summary, sourceBlock(document, source))
  figure.dataset.mermaid = "rendered"
  figure.replaceChildren(img, details)
}

export function showDiagramError(figure: HTMLElement, source: string, message: string): void {
  const document = figure.ownerDocument
  const note = document.createElement("div")
  note.className = "pm-block-error"
  note.setAttribute("role", "note")
  const title = document.createElement("strong")
  title.textContent = "Mermaid diagram could not render"
  const detail = document.createElement("span")
  detail.textContent = message
  note.append(title, detail)
  figure.dataset.mermaid = "error"
  figure.replaceChildren(note, sourceBlock(document, source))
}

let sequence = 0

// Svelte action for the rendered plan article.
export function mermaidDiagrams(root: HTMLElement): { destroy(): void } {
  let cancelled = false
  for (const figure of root.querySelectorAll<HTMLElement>('figure.mermaid-diagram[data-mermaid="pending"]')) {
    const source = figure.querySelector("code.language-mermaid")?.textContent ?? ""
    const id = `mermaid-${++sequence}`
    renderMermaid(id, source)
      .then(image => { if (!cancelled) showDiagram(figure, source, image) })
      .catch((reason: unknown) => { if (!cancelled) showDiagramError(figure, source, reason instanceof Error ? reason.message : String(reason)) })
  }
  return { destroy() { cancelled = true } }
}
