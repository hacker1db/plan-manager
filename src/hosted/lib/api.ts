import { HostedConfigurationError } from "./env"

export function apiError(error: unknown): Response {
  if (error instanceof HostedConfigurationError) return Response.json({ error: "Hosted service is unavailable" }, { status: 503 })
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON" }, { status: 400 })
  return Response.json({ error: "Request failed" }, { status: 500 })
}

export function publicPlan<T extends { objectKey: string }>(plan: T): Omit<T, "objectKey"> {
  const { objectKey, ...metadata } = plan
  return metadata
}

export function forbidden(): Response {
  return Response.json({ error: "Forbidden" }, { status: 403 })
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 })
}
