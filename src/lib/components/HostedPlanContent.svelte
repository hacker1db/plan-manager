<script lang="ts">
  import { sourceFormat } from "#lib/mdx/format.ts"
  import { PLAN_STATUSES, type PlanStatus } from "#lib/types.ts"
  import type { DashboardPlan } from "#lib/hosted/types.ts"
  import { requestStatusChange } from "#lib/hosted/status.ts"
  import { mermaidDiagrams } from "#lib/hosted/mermaid.ts"

  // `html` is escaped static markup produced on the server by src/lib/server/plan-markdown.tsx.
  let { plan, markdown, html }: { plan: DashboardPlan; markdown: string; html: string } = $props()

  let copyMessage = $state("")
  let copying = $state(false)
  let saving = $state(false)
  const formatLabel = $derived(sourceFormat(markdown) === "mdx" ? "MDX" : "Markdown")

  async function changeStatus(status: PlanStatus, select?: HTMLSelectElement) {
    if (status === plan.status) return
    if (status === "archived" && !window.confirm(`Archive “${plan.title}”?`)) {
      if (select) select.value = plan.status
      return
    }
    saving = true
    copyMessage = ""
    try {
      await requestStatusChange(plan.id, status)
      window.location.reload()
    } catch (error) {
      copyMessage = error instanceof Error ? error.message : "Could not update status"
      if (select) select.value = plan.status
      saving = false
    }
  }

  async function copySource() {
    copying = true
    copyMessage = ""
    try {
      await navigator.clipboard.writeText(markdown)
      copyMessage = `${formatLabel} copied`
    } catch {
      copyMessage = `Could not copy ${formatLabel}. Try Download ${formatLabel} instead.`
    } finally {
      copying = false
    }
  }
</script>

<header class="hero detail-hero"><p class="eyebrow">Plan record</p><h1>{plan.title}</h1></header>
<div class="metadata">
  <div class="meta is-{plan.status}"><span class="meta-label">Status</span><span class="meta-value"><span class="status-badge {plan.status}">{plan.status}</span></span></div>
  <div class="meta"><span class="meta-label">Updated</span><time class="meta-value plan-date" datetime={plan.updated}>{new Date(plan.updated).toLocaleString()}</time></div>
  <div class="meta"><span class="meta-label">Tags</span><span class="meta-value plan-meta">{#if plan.tags.length}{#each plan.tags as tag (tag)}<span class="plan-tag">{tag}</span>{/each}{:else}—{/if}</span></div>
  <div class="meta"><span class="meta-label">Revision</span><span class="meta-value rev" title={plan.revision}>{plan.revision.slice(0, 8)}</span></div>
</div>
<div class="detail-actions">
  <select class="status-select" aria-label="Plan status" disabled={saving} onchange={event => changeStatus(event.currentTarget.value as PlanStatus, event.currentTarget)}>
    {#each PLAN_STATUSES as status (status)}<option value={status} selected={status === plan.status}>{status}</option>{/each}
  </select>
  <button class="btn" type="button" onclick={copySource} disabled={copying}>{copying ? "Copying…" : `Copy ${formatLabel}`}</button>
  <a class="btn" href="/api/v1/plans/{encodeURIComponent(plan.id)}/content">Download {formatLabel}</a>
  {#if plan.status !== "archived"}<button class="btn danger" type="button" onclick={() => changeStatus("archived")} disabled={saving}>Archive</button>{/if}
  <span role="status">{copyMessage}</span>
</div>
<div class="document" use:mermaidDiagrams>{@html html}</div>
