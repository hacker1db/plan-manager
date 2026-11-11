// GFM table alignment arrives as an `align` property on <th>/<td>. react-markdown would turn it
// into an inline style="text-align: …" attribute, which the hosted Content Security Policy
// (style-src 'self', no 'unsafe-inline') blocks. Swap it for a class the stylesheet defines.

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

const ALIGNMENTS = new Set(["left", "center", "right"])

function visit(node: HastNode): void {
  if (node.type === "element" && (node.tagName === "th" || node.tagName === "td") && node.properties) {
    const align = node.properties.align
    delete node.properties.align
    if (typeof align === "string" && ALIGNMENTS.has(align)) {
      const existing = node.properties.className
      const classes = Array.isArray(existing) ? existing.map(String) : typeof existing === "string" ? existing.split(/\s+/).filter(Boolean) : []
      node.properties.className = [...classes, `pm-align-${align}`]
    }
  }
  for (const child of node.children ?? []) visit(child)
}

export function rehypeAlignClasses() {
  return (tree: HastNode) => visit(tree)
}
