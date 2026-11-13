import type { Plan, PlanListResponse, PlanRenderResponse, PlanStatus } from "./shared"
import { parseUrl } from "./url"

export type ApiErrorKind = "signedOut" | "forbidden" | "notFound" | "conflict" | "locked" | "unavailable" | "transport"

const MESSAGES: Record<ApiErrorKind, string> = {
  signedOut: "Your session expired. Sign in again.",
  forbidden: "This account cannot access the owner's library.",
  notFound: "This plan is no longer available.",
  conflict: "The plan changed. Refresh and review it before retrying.",
  locked: "This plan uses lifecycle review gates. Change its status through the CLI review workflow.",
  unavailable: "The service could not complete this request. Try again.",
  transport: "Unable to connect. Check your connection and retry.",
}

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind) { super(MESSAGES[kind]) }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : MESSAGES.unavailable
}

export interface PlanRepository {
  library(): Promise<Plan[]>
  document(id: string): Promise<PlanRenderResponse>
  setStatus(plan: Plan, status: PlanStatus): Promise<Plan>
}

const STATUS_ERRORS: Record<number, ApiErrorKind> = { 401: "signedOut", 403: "forbidden", 404: "notFound", 409: "conflict", 422: "locked" }
const PAGE_SIZE = 100
const MAX_OFFSET = 100_000

export function createApiRepository(options: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }): PlanRepository {
  const { baseUrl, getToken } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const base = parseUrl(baseUrl)
  if (!base || base.scheme !== "https" || base.authority.includes("@")) throw new ApiError("unavailable")
  const origin = `https://${base.authority}`

  async function send(segments: string[], init: { query?: Record<string, string>; body?: unknown; accept?: string } = {}): Promise<Response> {
    const token = await getToken()
    const path = ["api", "v1", "plans", ...segments.map(encodeURIComponent)].join("/")
    const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : ""
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: init.accept ?? "application/json" }
    if (init.body !== undefined) headers["Content-Type"] = "application/json"
    let response: Response
    try {
      response = await fetchImpl(`${origin}/${path}${query}`, {
        method: init.body === undefined ? "GET" : "POST",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // Bearer only: never send or accept ambient cookies, and never follow redirects with the token.
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      })
    } catch { throw new ApiError("transport") }
    if (response.redirected || (response.url && !response.url.startsWith(`${origin}/`))) throw new ApiError("unavailable")
    if (response.status !== 200) throw new ApiError(STATUS_ERRORS[response.status] ?? "unavailable")
    return response
  }

  async function request<T>(segments: string[], init: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const response = await send(segments, init)
    try { return (await response.json()) as T } catch { throw new ApiError("unavailable") }
  }

  return {
    async library() {
      const plans = new Map<string, Plan>()
      let offset = 0
      while (offset < MAX_OFFSET) {
        const page = await request<PlanListResponse>([], { query: { limit: String(PAGE_SIZE), offset: String(offset) } })
        if (!Array.isArray(page.plans)) throw new ApiError("unavailable")
        for (const plan of page.plans) plans.set(plan.id, plan)
        const next = page.nextOffset
        if (next === null || next === undefined) return [...plans.values()].sort((a, b) => b.updated.localeCompare(a.updated))
        if (!Number.isInteger(next) || next <= offset) throw new ApiError("unavailable")
        offset = next
      }
      throw new ApiError("unavailable")
    },
    document: id => request<PlanRenderResponse>([id, "render"]),
    setStatus: (plan, status) => request<Plan>([plan.id, "status"], { body: { status, expectedRevision: plan.revision } }),
  }
}
