// Minimal strict parser for https and private-scheme URLs. React Native's URL polyfill has
// historically mis-parsed custom schemes, so security checks never rely on it.
export type ParsedUrl = { scheme: string; authority: string; path: string; query: string | null; fragment: string | null }

const PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i

export function parseUrl(value: string): ParsedUrl | null {
  const match = PATTERN.exec(value)
  if (!match) return null
  return { scheme: match[1].toLowerCase(), authority: match[2], path: match[3], query: match[4] ?? null, fragment: match[5] ?? null }
}

export function queryParams(query: string | null): [string, string][] {
  if (!query) return []
  return query.split("&").filter(Boolean).map(pair => {
    const index = pair.indexOf("=")
    const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "))
    return index < 0 ? [decode(pair), ""] : [decode(pair.slice(0, index)), decode(pair.slice(index + 1))]
  })
}

export function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")
}
