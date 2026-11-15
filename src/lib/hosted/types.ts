import type { PlanStatus } from "../types.ts"

// plans:read was never minted or required by anything (owner reads use the WorkOS session).
export const PLAN_SCOPES = ["plans:write"] as const

export type PlanScope = (typeof PLAN_SCOPES)[number]

export type HostedPlanInput = {
  id: string
  title: string
  status: PlanStatus
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

export type DashboardPlan = Pick<HostedPlan, "id" | "title" | "status" | "tags" | "created" | "updated" | "revision">

export type CliToken = {
  id: string
  scopes: readonly PlanScope[]
  expiresAt: Date
  revokedAt: Date | null
}

export type TokenRecord = CliToken & { secretHash: string }

// What GET /api/v1/tokens returns: never the secret hash.
export type TokenSummary = CliToken & { lastUsedAt: Date | null; createdAt: Date | null }
