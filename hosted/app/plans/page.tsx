import { redirect } from "next/navigation"
import { currentUser } from "@clerk/nextjs/server"
import { getHostedEnvironment } from "../../lib/env"
import { listPlans } from "../../lib/store"

export const dynamic = "force-dynamic"

export default async function PlansPage() {
  const user = await currentUser()
  if (!user) redirect("/sign-in")
  if (user.id !== getHostedEnvironment().ownerClerkUserId) return <main><h1>Access denied</h1><p className="muted">This private plan library belongs to another account.</p></main>
  const plans = await listPlans()
  return <main><h1>Plans</h1><p className="muted">Private hosted plan library</p>{plans.length === 0 ? <p>No hosted plans yet. Configure a remote, then run <code>plan push</code>.</p> : plans.map(plan => <a className="card" href={`/plans/${plan.id}`} key={plan.id}><strong>{plan.title}</strong><br /><span className="muted">{plan.status} · updated {new Date(plan.updated).toLocaleString()}</span></a>)}</main>
}
