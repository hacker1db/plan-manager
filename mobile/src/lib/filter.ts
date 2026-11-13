import type { Plan, PlanStatus } from "./shared"

export type StatusFilter = "all" | PlanStatus

export function visiblePlans(plans: readonly Plan[], filter: StatusFilter, query: string): Plan[] {
  const needle = query.trim().toLocaleLowerCase()
  return plans.filter(plan =>
    (filter === "all" || plan.status === filter)
    && (!needle || `${plan.title} ${plan.tags.join(" ")}`.toLocaleLowerCase().includes(needle)))
}
