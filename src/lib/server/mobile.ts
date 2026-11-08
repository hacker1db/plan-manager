import yaml from "js-yaml"
import type { HostedPlan, HostedPlanInput } from "../hosted/types.ts"
import { isPlanStatus, type PlanStatus } from "../types.ts"

export function statusAvailability(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  try {
    const meta = yaml.load(match[1])
    if (meta && typeof meta === "object" && ("tracking" in meta || "schemaVersion" in meta))
      return "This plan uses lifecycle review gates. Change its status through the canonical CLI review workflow."
    return null
  } catch { return "Plan metadata could not be validated. Status changes are unavailable." }
}

export function statusInput(input: unknown): { status: PlanStatus; expectedRevision: string } | null {
  if (!input || typeof input !== "object" || !("status" in input) || !("expectedRevision" in input)) return null
  return isPlanStatus(input.status) && typeof input.expectedRevision === "string" && /^[a-f0-9]{64}$/.test(input.expectedRevision)
    ? { status: input.status, expectedRevision: input.expectedRevision } : null
}

export async function changeMobileStatus(id: string, input: { status: PlanStatus; expectedRevision: string }, dependencies: {
  find: (id: string) => Promise<HostedPlan | null>;
  read: (plan: HostedPlan) => Promise<string>;
  version: (markdown: string, plan: HostedPlan, status: PlanStatus, updated: string) => Promise<{markdown: string; revision: string}>;
  write: (input: HostedPlanInput) => Promise<{plan: HostedPlan; conflict: boolean}>;
}) {
  const plan = await dependencies.find(id)
  if (!plan) return { status: 404, error: "Not found" }
  if (plan.revision !== input.expectedRevision) return { status: 409, error: "Plan changed. Refresh before retrying.", currentRevision: plan.revision }
  const markdown = await dependencies.read(plan)
  const reason = statusAvailability(markdown)
  if (reason) return { status: 422, error: reason }
  if (plan.status === input.status) return { status: 200, plan }
  const updated = new Date().toISOString()
  const version = await dependencies.version(markdown, plan, input.status, updated)
  const result = await dependencies.write({ ...plan, ...version, status: input.status, updated, expectedRevision: input.expectedRevision })
  return result.conflict ? { status: 409, error: "Plan changed. Refresh before retrying.", currentRevision: result.plan?.revision } : {status: 200, plan: result.plan}
}
