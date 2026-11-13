import { parseUrl } from "./url"

export type AppConfig = { serviceUrl: string; clientId: string; redirectUri: string; fixtures: boolean; t3Repo: string }

export function readConfig(extra: Record<string, unknown>): AppConfig {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  return {
    serviceUrl: text(extra.planServiceUrl).replace(/\/$/, ""),
    clientId: text(extra.workosClientId),
    redirectUri: text(extra.workosRedirectUri),
    fixtures: extra.fixtures === true,
    t3Repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text(extra.t3Repo)) ? text(extra.t3Repo) : "",
  }
}

/** Service must be a bare https origin; the redirect a reverse-domain private scheme (never loopback). */
export function isConfigured(config: AppConfig): boolean {
  const service = parseUrl(config.serviceUrl)
  const redirect = parseUrl(config.redirectUri)
  return /^client_[A-Za-z0-9]+$/.test(config.clientId)
    && service !== null && service.scheme === "https" && /^[A-Za-z0-9.-]+(:\d+)?$/.test(service.authority) && service.path === "" && service.query === null && service.fragment === null
    && redirect !== null && redirect.scheme.includes(".") && !["http", "https"].includes(redirect.scheme)
    && /^[A-Za-z0-9.-]+$/.test(redirect.authority) && redirect.query === null && redirect.fragment === null
}
