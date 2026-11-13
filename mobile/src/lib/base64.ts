const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export function base64UrlEncode(bytes: Uint8Array): string {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    const length = Math.min(3, bytes.length - index)
    for (let position = 0; position <= length; position++) output += ALPHABET[(chunk >> (18 - position * 6)) & 63]
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_")
}

export function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decodes base64url to a UTF-8 string, or null when malformed. */
export function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of normalized) {
    buffer = (buffer << 6) | ALPHABET.indexOf(character)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255) }
  }
  try { return decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("")) } catch { return null }
}
