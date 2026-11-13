// The single bridge to the web app's contract. These files are dependency-free, so Metro can
// bundle them (metro.config.js watches ../src/lib) and the API shapes cannot drift apart.
export { PLAN_STATUSES, isPlanStatus } from "../../../src/lib/types.ts"
export type { PlanStatus } from "../../../src/lib/types.ts"
export type {
  DashboardPlan as Plan,
  HeadingAnchor,
  PlanListResponse,
  PlanRenderResponse,
} from "../../../src/lib/hosted/types.ts"
