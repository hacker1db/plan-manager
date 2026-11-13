const EXTERNAL = /^(https?|mailto):/i

/** The reader loads only its own inline document; permitted links open in the system, everything else is dropped. */
export function shouldLoadInReader(request: { url: string }, open: (url: string) => void): boolean {
  if (request.url.startsWith("about:")) return true
  if (EXTERNAL.test(request.url)) open(request.url)
  return false
}
