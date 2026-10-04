import { NextResponse } from "next/server"
import { apiError, publicPlan } from "../../../../lib/api"
import { requireOwnerResponse } from "../../../../lib/auth"
import { listPlans } from "../../../../lib/store"

export async function GET() {
  const denied = await requireOwnerResponse()
  if (denied) return denied
  try { return NextResponse.json({ version: 1, plans: (await listPlans()).map(publicPlan) }, { headers: { "Cache-Control": "private, no-store" } }) } catch (error) { return apiError(error) }
}
