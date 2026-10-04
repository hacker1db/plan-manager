export const PLAN_SCOPES = ["plans:read", "plans:write"] as const

export type PlanScope = (typeof PLAN_SCOPES)[number]

export type HostedPlanInput = {
  id: string
  title: string
  status: "active" | "completed" | "archived"
  tags: string[]
  created: string
  updated: string
  markdown: string
  revision: string
  expectedRevision: string | null
}

export type HostedPlan = Omit<HostedPlanInput, "markdown" | "expectedRevision"> & {
  objectKey: string
}

export type CliToken = {
  id: string
  scopes: readonly PlanScope[]
  expiresAt: Date
  revokedAt: Date | null
}

export type TokenRecord = CliToken & { secretHash: string }
