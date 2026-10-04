import { NextResponse } from "next/server"
import { HostedConfigurationError } from "./env"

export function apiError(error: unknown): NextResponse {
  if (error instanceof HostedConfigurationError) return NextResponse.json({ error: "Hosted service is unavailable" }, { status: 503 })
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  return NextResponse.json({ error: "Request failed" }, { status: 500 })
}

export function publicPlan<T extends { objectKey: string }>(plan: T): Omit<T, "objectKey"> {
  const { objectKey, ...metadata } = plan
  return metadata
}

export function forbidden(): NextResponse {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 })
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
