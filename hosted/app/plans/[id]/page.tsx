import { notFound, redirect } from "next/navigation"
import { currentUser } from "@clerk/nextjs/server"
import { getHostedEnvironment } from "../../../lib/env"
import { findPlan, readMarkdown } from "../../../lib/store"

export const dynamic = "force-dynamic"

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect("/sign-in")
  if (user.id !== getHostedEnvironment().ownerClerkUserId) return <main><h1>Access denied</h1></main>
  const plan = await findPlan((await params).id)
  if (!plan) notFound()
  const markdown = await readMarkdown(plan)
  return <main><a href="/plans">← Plans</a><h1>{plan.title}</h1><p className="muted">{plan.status} · {plan.updated}</p><pre>{markdown}</pre></main>
}
