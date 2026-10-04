import { notFound } from "next/navigation"
import { findPlan, readMarkdown } from "@/hosted/lib/store"
import { publicPlan } from "@/hosted/lib/api"
import SharedDashboard from "@/components/shared-dashboard"

export const dynamic = "force-dynamic"

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const plan = await findPlan((await params).id)
  if (!plan) notFound()
  const markdown = await readMarkdown(plan)
  return <SharedDashboard kind="plan" plan={publicPlan(plan)} markdown={markdown} />
}
