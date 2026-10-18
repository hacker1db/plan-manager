// @ts-nocheck
import { mkdir, readdir, lstat, realpath, rename, open, unlink } from 'node:fs/promises'
import { join, resolve, normalize, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { getPlanHome } from './config.js'
import { extensionFor, isPlanFilename, stripPlanExtension } from './mdx/format.js'

export function planHome() {
  return getPlanHome()
}

export function archiveDir() {
  return join(planHome(), 'archive')
}

export async function initStorage() {
  const root = planHome()
  const archive = archiveDir()
  for (const [index, dir] of [root, archive].entries()) {
    let s
    try {
      s = await lstat(dir)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      s = null
    }
    if (s !== null && (!s.isDirectory() || s.isSymbolicLink())) {
      const err = new Error(`Path exists but is not a directory: ${dir}`)
      err.code = 'ENOTDIR'
      throw err
    }
    if (s === null) {
      await mkdir(dir, { recursive: true })
    }
    if (index === 1 && !(await containedPathReal(dir))) {
      const err = new Error(`Path escapes plan home: ${dir}`)
      err.code = 'EPATHTRAVERSAL'
      throw err
    }
  }
}

function pathInside(root, target) {
  return target === root || target.startsWith(root + '/')
}

async function realTarget(filePath) {
  let current = filePath
  const missing = []
  while (true) {
    try {
      const s = await lstat(current)
      if (s.isSymbolicLink()) return null
      return join(await realpath(current), ...missing)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      const parent = dirname(current)
      if (parent === current) throw err
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function realTargetSync(filePath) {
  let current = filePath
  const missing = []
  while (true) {
    try {
      const s = lstatSync(current)
      if (s.isSymbolicLink()) return null
      return join(realpathSync(current), ...missing)
    } catch (err) {
      if (err.code !== 'ENOENT') return null
      const parent = dirname(current)
      if (parent === current) return null
      missing.unshift(basename(current))
      current = parent
    }
  }
}

export async function containedPathReal(filePath) {
  const root = normalize(resolve(planHome()))
  const target = normalize(resolve(filePath))
  if (!pathInside(root, target)) return false
  try {
    const rootReal = normalize(await realpath(root))
    const resolvedTarget = await realTarget(target)
    if (resolvedTarget === null) return false
    return pathInside(rootReal, normalize(resolvedTarget))
  } catch {
    return false
  }
}

async function safeMarkdownFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !isPlanFilename(entry.name)) continue
    const filePath = join(dir, entry.name)
    if (await containedPathReal(filePath)) files.push(filePath)
  }
  return files
}

export async function listPlanFiles() {
  return safeMarkdownFiles(planHome())
}

export async function listArchiveFiles() {
  return safeMarkdownFiles(archiveDir())
}

export async function allPlanFiles() {
  const [active, archived] = await Promise.all([listPlanFiles(), listArchiveFiles()])
  return [...active, ...archived]
}

export function planPath(slug, format = 'md') {
  return join(planHome(), `${slug}${extensionFor(format)}`)
}

export function archivePath(slug, format = 'md') {
  return join(archiveDir(), `${slug}${extensionFor(format)}`)
}

async function slugTaken(pathFor, slug) {
  // A slug is one identifier regardless of format, so plan.md and plan.mdx never coexist.
  return (await pathEntryExists(pathFor(slug, 'md'))) || (await pathEntryExists(pathFor(slug, 'mdx')))
}

export function containedPath(filePath) {
  const root = normalize(resolve(planHome()))
  const target = normalize(resolve(filePath))
  if (!pathInside(root, target)) return false
  try {
    const rootReal = normalize(realpathSync(root))
    const resolvedTarget = realTargetSync(target)
    if (resolvedTarget === null) return false
    return pathInside(rootReal, normalize(resolvedTarget))
  } catch {
    return false
  }
}

export async function atomicWrite(filePath, content) {
  if (!(await containedPathReal(filePath))) {
    const err = new Error(`Path escapes plan home: ${filePath}`)
    err.code = 'EPATHTRAVERSAL'
    throw err
  }
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`)
  let handle
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if (!(await containedPathReal(filePath))) {
      const err = new Error(`Path escapes plan home: ${filePath}`)
      err.code = 'EPATHTRAVERSAL'
      throw err
    }
    await rename(tmp, filePath)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

export async function resolveByIdOrSlug(idOrSlug) {
  const files = await allPlanFiles()
  const { readPlan } = await import('./metadata.js')
  const matches = []
  for (const f of files) {
    let parsed
    try { parsed = await readPlan(f) } catch { continue }
    if (parsed.meta.id === idOrSlug) {
      return { filePath: f, meta: parsed.meta }
    }
    const slug = stripPlanExtension(f.split('/').pop())
    if (slug === idOrSlug) {
      matches.push({ filePath: f, meta: parsed.meta })
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    const err = new Error(`Ambiguous identifier "${idOrSlug}" matches: ${matches.map(m => m.meta.id).join(', ')}`)
    err.code = 'EAMBIGUOUS'
    err.matches = matches
    throw err
  }
  const err = new Error(`Plan not found: ${idOrSlug}`)
  err.code = 'ENOTFOUND'
  throw err
}

export async function uniqueSlug(baseSlug) {
  if (!(await slugTaken(planPath, baseSlug))) return baseSlug
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseSlug}-${i}`
    if (!(await slugTaken(planPath, candidate))) return candidate
  }
  const err = new Error(`No available filename slot for slug "${baseSlug}"`)
  err.code = 'ESLOTFULL'
  throw err
}

export async function uniqueArchivePath(baseSlug, format = 'md') {
  if (!(await slugTaken(archivePath, baseSlug))) return archivePath(baseSlug, format)
  for (let i = 2; i <= 999; i++) {
    const candidate = `${baseSlug}-${i}`
    if (!(await slugTaken(archivePath, candidate))) return archivePath(candidate, format)
  }
  const err = new Error(`No available archive filename slot for slug "${baseSlug}"`)
  err.code = 'ESLOTFULL'
  throw err
}

async function pathEntryExists(filePath) {
  try {
    await lstat(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}
