import { renderToStaticMarkup } from 'react-dom/server'
import PlanMarkdown from '@/components/plan-markdown'
import { libraryBody, planBody } from '@/components/generated-dashboard'
import { sourceFormat } from '@/lib/mdx/format'
import type { DashboardPlan } from './types'

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function hosted(shell: string): string {
  return shell.replaceAll('data-dashboard-environment="local"', 'data-dashboard-environment="hosted"')
    .replaceAll('Local library', 'Private library')
    .replaceAll('Local only · 127.0.0.1', 'Private · Owner access')
    .replace('<div class="rail-foot">', '<div class="rail-foot">\n        <form method="post" action="/sign-out" style="display:contents"><button class="action" type="submit">Sign out</button></form>')
}

export function hostedLibraryShell(): string {
  return hosted(libraryBody)
}

export function hostedPlanShell(plan: DashboardPlan, markdown: string): string {
  const format = sourceFormat(markdown) === 'mdx' ? 'MDX' : 'Markdown'
  const tags = plan.tags.length ? plan.tags.map(tag => `<span class="plan-tag">${html(tag)}</span>`).join('') : '—'
  const content = `<header class="hero detail-hero"><p class="eyebrow">Plan record</p><h1>${html(plan.title)}</h1></header>
    <div class="metadata">
      <div class="meta is-${html(plan.status)}"><span class="meta-label">Status</span><span class="meta-value"><span class="status-badge ${html(plan.status)}">${html(plan.status)}</span></span></div>
      <div class="meta"><span class="meta-label">Updated</span><time class="meta-value plan-date" datetime="${html(plan.updated)}">${html(new Date(plan.updated).toLocaleString())}</time></div>
      <div class="meta"><span class="meta-label">Tags</span><span class="meta-value plan-meta">${tags}</span></div>
      <div class="meta"><span class="meta-label">Revision</span><span class="meta-value rev" title="${html(plan.revision)}">${html(plan.revision.slice(0, 8))}</span></div>
    </div>
    <div class="detail-actions">
      <button class="btn" type="button" data-copy-source>Copy ${format}</button>
      <a class="btn" href="/api/v1/plans/${encodeURIComponent(plan.id)}/content">Download ${format}</a>
    </div>
    <div class="document">${renderToStaticMarkup(<PlanMarkdown markdown={markdown} />)}</div>`
  return hosted(planBody).replace('<div id="detail">', `<div id="detail" data-revision="${html(plan.revision)}">`).replace(/<p class="loading">Loading plan…<\/p>/, () => content)
}
