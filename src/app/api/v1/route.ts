import { NextResponse } from "next/server"
import { HostedConfigurationError, getCliOAuthConfiguration } from "@/hosted/lib/env"

export async function GET() {
  try {
    return NextResponse.json({ version: 1, ...getCliOAuthConfiguration() }, { headers: { "Cache-Control": "public, max-age=300" } })
  } catch (error) {
    if (error instanceof HostedConfigurationError) return NextResponse.json({ error: "CLI authentication is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } })
    throw error
  }
}
