import {createHash} from "node:crypto"
import {renderPlanHtml} from "./plan-markdown.tsx"

import type {HeadingAnchor} from "../hosted/types.ts"
export type {HeadingAnchor}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
// Input is escaped static output from our non-executing Markdown/MDX renderer, never raw HTML.
export function mobileDocument(markdown: string): {html: string; headings: HeadingAnchor[]} {
  const html = renderPlanHtml(markdown)
  const matches = [...html.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)]
  const headings: HeadingAnchor[] = []
  const parents: string[] = []
  const occurrences = new Map<string, number>()
  let index = 0
  const output = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (whole, depthText: string, content: string) => {
    const depth = Number(depthText)
    const title = content.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '\"').replace(/&#x27;/g, "'").trim()
    parents.length = depth - 1
    parents[depth - 1] = title
    const path = parents.filter(value => value !== undefined)
    const identity = hash(JSON.stringify(path)).slice(0, 20)
    const occurrence = (occurrences.get(identity) ?? 0) + 1
    occurrences.set(identity, occurrence)
    const id = `section-${identity}-${occurrence}`
    const match = matches[index]
    const end = matches[index + 1]?.index ?? html.length
    const context = html.slice((match.index ?? 0) + whole.length, end).replace(/<\/article>$/, "").replace(/\s+/g, " ").trim()
    headings.push({id, path, title, fingerprint: hash(context)})
    index++
    return `<h${depth} id="${id}">${content}</h${depth}>`
  })
  return {html: output, headings}
}

// Never silently move ambiguous feedback. Keep original anchor in the stored record.
export function resolveAnchor(original: HeadingAnchor, current: HeadingAnchor[]): HeadingAnchor | null {
  const exact = current.filter(anchor => JSON.stringify(anchor.path) === JSON.stringify(original.path))
  if (exact.length === 1) return exact[0]
  const context = current.filter(anchor => anchor.title === original.title && anchor.fingerprint === original.fingerprint)
  return context.length === 1 ? context[0] : null
}
