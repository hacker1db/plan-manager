// Content Security Policy for pages SvelteKit renders. vite.config.ts passes these directives to
// SvelteKit's `csp` option, which adds a per-request nonce for its own inline hydration script.
// Keywords are written without quotes; SvelteKit quotes them when it builds the header.
//
// - script-src 'self' (no 'strict-dynamic'): SharedDashboard.svelte injects <script src="/app.js">
//   and <script src="/plan.js"> at runtime without a nonce, so same-origin loading must stay valid.
// - style-src 'self': all app CSS ships as files; table alignment uses classes (src/lib/mdx/align.ts).
//   style-src-elem/style-src-attr also allow inline styles because Mermaid (and d3) build each
//   diagram in a temporary in-page SVG with a per-diagram <style> element and style attributes;
//   that CSS is generated per render, so it cannot be hashed. Blocking it logs violations and can
//   skew Mermaid's text measurement. Plan content cannot inject styles: Markdown is rendered with
//   raw HTML skipped and MDX is never evaluated. Scripts stay strict.
// - img-src data:: Mermaid diagrams are shown as <img src="data:image/svg+xml,…">.
// - connect-src 'self': dashboard API calls and Vercel Analytics (/_vercel/insights/*).
export const CSP_DIRECTIVES = {
  "default-src": ["self"],
  "script-src": ["self"],
  "style-src": ["self"],
  "style-src-elem": ["self", "unsafe-inline"],
  "style-src-attr": ["unsafe-inline"],
  "img-src": ["self", "data:"],
  "connect-src": ["self"],
  "font-src": ["self"],
  "object-src": ["none"],
  "base-uri": ["none"],
  "frame-ancestors": ["none"],
  "form-action": ["self", "https://api.workos.com"],
} as const satisfies Record<string, readonly string[]>

// For responses SvelteKit did not render (JSON APIs, redirects, the fail-closed 503, static
// assets served through the hook): nothing may load or frame them.
export const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'"
