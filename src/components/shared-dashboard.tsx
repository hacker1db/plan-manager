import Script from "next/script"
import { libraryBody, planBody } from "./generated-dashboard"
import HostedPlanPortal from "./hosted-plan-portal"
import type { DashboardPlan } from "@/hosted/lib/types"

type View =
  | { kind: "library" }
  | { kind: "plan"; plan: DashboardPlan; markdown: string }

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

export default function SharedDashboard(view: View) {
  const hostedShell = (view.kind === "library" ? libraryBody : planBody).replaceAll('data-dashboard-environment="local"', 'data-dashboard-environment="hosted"')
  const body = view.kind === "library"
    ? hostedShell
    : hostedShell.replace('<div id="detail">', `<div id="detail" data-revision="${html(view.plan.revision)}">`)
  return <><div dangerouslySetInnerHTML={{ __html: body }} />{view.kind === "plan" && <HostedPlanPortal plan={view.plan} markdown={view.markdown} />}<Script src={view.kind === "library" ? "/app.js" : "/plan.js"} strategy="afterInteractive" /></>
}
