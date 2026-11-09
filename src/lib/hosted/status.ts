import type { PlanStatus } from "../types.ts"

export async function requestStatusChange(id: string, status: PlanStatus, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`/api/plans/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  })
  if (response.ok) return
  const value: unknown = await response.json().catch(() => null)
  const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : null
  throw new Error(message ?? `Request failed with ${response.status}`)
}
