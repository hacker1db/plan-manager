export function isSameOriginRequest(request: Pick<Request, "url" | "headers">): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function isJsonRequest(request: Pick<Request, "headers">): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json"
}
