import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js'])

export interface BuildFreshness {
  stale: boolean
  reason?: string
}

function newestMtime(dir: string): number {
  let newest = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path))
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue
    try {
      newest = Math.max(newest, statSync(path).mtimeMs)
    } catch { }
  }
  return newest
}

/**
 * Compare the compiled CLI under `distDir` against the TypeScript sources next
 * to it. Returns `null` when there is nothing to compare (no `src/cli`, as in a
 * packed install, or no built entry point). Never throws.
 */
export function checkBuildFreshness(distDir: string): BuildFreshness | null {
  try {
    const root = resolve(distDir, '..')
    const srcCli = join(root, 'src', 'cli')
    const entry = join(distDir, 'cli', 'index.js')
    let builtAt: number
    try {
      if (!statSync(srcCli).isDirectory()) return null
      builtAt = statSync(entry).mtimeMs
    } catch {
      return null
    }
    const newestSource = Math.max(newestMtime(srcCli), newestMtime(join(root, 'src', 'lib')))
    if (newestSource > builtAt) {
      return { stale: true, reason: 'src/ is newer than dist/cli/index.js' }
    }
    return { stale: false }
  } catch {
    return null
  }
}

/** The version from the package.json two levels above this module (works from `src/` and `dist/`). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
