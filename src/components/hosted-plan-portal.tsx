"use client"

import { createPortal } from "react-dom"
import { useEffect, useState } from "react"
import PlanMarkdown from "./plan-markdown"
import { sourceFormat } from "@/lib/mdx/format"
import type { DashboardPlan } from "@/hosted/lib/types"

function HostedPlanContent({ plan, markdown }: { plan: DashboardPlan; markdown: string }) {
  const [copyMessage, setCopyMessage] = useState("")
  const [copying, setCopying] = useState(false)
  const formatLabel = sourceFormat(markdown) === "mdx" ? "MDX" : "Markdown"
  async function copySource() {
    setCopying(true)
    setCopyMessage("")
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyMessage(`${formatLabel} copied`)
    } catch {
      setCopyMessage(`Could not copy ${formatLabel}. Try Download ${formatLabel} instead.`)
    } finally {
      setCopying(false)
    }
  }
  const tags = plan.tags.length
    ? plan.tags.map(tag => <span className="plan-tag" key={tag}>{tag}</span>)
    : "—"
  return <>
    <header className="hero detail-hero"><p className="eyebrow">Plan record</p><h1>{plan.title}</h1></header>
    <div className="metadata">
      <div className={`meta is-${plan.status}`}><span className="meta-label">Status</span><span className="meta-value"><span className={`status-badge ${plan.status}`}>{plan.status}</span></span></div>
      <div className="meta"><span className="meta-label">Updated</span><time className="meta-value plan-date" dateTime={plan.updated}>{new Date(plan.updated).toLocaleString()}</time></div>
      <div className="meta"><span className="meta-label">Tags</span><span className="meta-value plan-meta">{tags}</span></div>
      <div className="meta"><span className="meta-label">Revision</span><span className="meta-value rev" title={plan.revision}>{plan.revision.slice(0, 8)}</span></div>
    </div>
    <div className="detail-actions">
      <button className="btn" type="button" onClick={copySource} disabled={copying}>{copying ? "Copying…" : `Copy ${formatLabel}`}</button>
      <a className="btn" href={`/api/v1/plans/${encodeURIComponent(plan.id)}/content`}>Download {formatLabel}</a>
      <span role="status">{copyMessage}</span>
    </div>
    <div className="document"><PlanMarkdown markdown={markdown} /></div>
  </>
}

export default function HostedPlanPortal({ plan, markdown }: { plan: DashboardPlan; markdown: string }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.querySelector<HTMLElement>("#detail")
    if (!element) return
    element.replaceChildren()
    setTarget(element)
  }, [])
  if (!target) return null
  return createPortal(<HostedPlanContent plan={plan} markdown={markdown} />, target)
}
