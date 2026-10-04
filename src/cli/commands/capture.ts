// @ts-nocheck
import { lstat, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, extname, normalize, resolve } from 'node:path'
import { allPlanFiles, initStorage, planPath, uniqueSlug } from '../../lib/storage.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { generateId, slugify } from '../../lib/ids.js'
import { normalizeMeta, parseFrontmatter, readPlan, writePlan } from '../../lib/metadata.js'
import { withPlanWriteLock } from '../../lib/write-lock.js'
import { EXIT } from '../exit.js'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

function captureError(message, exitCode) {
  const err = new Error(message)
  err.exitCode = exitCode
  return err
}

function artifactTitle(sourcePath) {
  const extension = extname(sourcePath)
  return basename(sourcePath, extension).replace(/[-_]+/g, ' ').trim()
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (entity, number) => {
      const codePoint = Number(number)
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlTitle(raw) {
  const match = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  return match ? decodeHtml(match[1]) : ''
}

function convertHtml(raw) {
  const executable = process.env.PLAN_PANDOC || 'pandoc'
  const result = spawnSync(executable, [
    '--from=html',
    '--to=gfm-raw_html',
    '--wrap=none',
    '--strip-comments',
  ], {
    input: raw,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  })
  if (result.error?.code === 'ENOENT') {
    throw captureError(
      `Pandoc is required to capture HTML artifacts (${executable} not found)`,
      EXIT.DEPENDENCY_UNAVAILABLE
    )
  }
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `Pandoc exited with ${result.status}`
    throw captureError(`Error converting HTML artifact: ${detail}`, EXIT.INVALID_INPUT)
  }
  return result.stdout
}

function comparableMeta(meta) {
  return JSON.stringify({
    title: meta.title,
    status: meta.status,
    tags: meta.tags,
    source: meta.source,
  })
}

async function sourceMatches(sourcePath) {
  const matches = []
  for (const filePath of await allPlanFiles()) {
    let parsed
    try {
      parsed = await readPlan(filePath)
    } catch {
      continue
    }
    if (normalize(resolve(filePath)) === sourcePath ||
        (parsed.meta.source && normalize(resolve(parsed.meta.source)) === sourcePath)) {
      matches.push(parsed)
    }
  }
  return matches
}

export async function cmdCapture(args, opts) {
  const source = args[0]
  if (!source) {
    process.stderr.write('Error: artifact argument required\n  Usage: plan capture <artifact> [--title <title>] [--json]\n')
    process.exit(EXIT.INVALID_INPUT)
  }

  const sourcePath = normalize(resolve(source))
  const extension = extname(sourcePath).toLowerCase()
  if (!MARKDOWN_EXTENSIONS.has(extension) && !HTML_EXTENSIONS.has(extension)) {
    process.stderr.write('Error: plan capture accepts only Markdown or HTML artifacts\n')
    process.exit(EXIT.INVALID_INPUT)
  }

  await initStorage()
  try {
    const envelope = await withPlanWriteLock(async () => {
      let info
      try {
        info = await lstat(sourcePath)
      } catch (err) {
        throw captureError(`Error reading artifact: ${err.message}`, EXIT.INVALID_INPUT)
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw captureError('Artifact must be a regular Markdown or HTML file', EXIT.INVALID_INPUT)
      }
      if (info.size > MAX_ARTIFACT_BYTES) {
        throw captureError(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`, EXIT.INVALID_INPUT)
      }

      let raw
      try {
        raw = await readFile(sourcePath, 'utf8')
      } catch (err) {
        throw captureError(`Error reading artifact: ${err.message}`, EXIT.INVALID_INPUT)
      }
      const isHtml = HTML_EXTENSIONS.has(extension)
      const converted = isHtml ? convertHtml(raw) : raw
      const { meta: sourceMeta, body } = parseFrontmatter(converted)
      const canonicalBody = body.startsWith('\n') ? body : `\n${body}`
      const inferredTitle = isHtml ? htmlTitle(raw) : sourceMeta.title
      const matches = await sourceMatches(sourcePath)
      if (matches.length > 1) {
        throw captureError(
          `Artifact source is already associated with multiple plans: ${matches.map(item => item.meta.id).join(', ')}`,
          EXIT.AMBIGUOUS
        )
      }

      let parsed
      let action
      if (matches.length === 1) {
        const existing = matches[0]
        const meta = normalizeMeta({
          ...existing.meta,
          ...(sourceMeta.status ? { status: sourceMeta.status } : {}),
          ...(Array.isArray(sourceMeta.tags) ? { tags: sourceMeta.tags } : {}),
          title: opts.title || inferredTitle || existing.meta.title,
          source: sourcePath,
        })
        if (existing.body === canonicalBody && comparableMeta(existing.meta) === comparableMeta(meta)) {
          parsed = existing
          action = 'unchanged'
        } else {
          await writePlan(existing.filePath, meta, canonicalBody)
          parsed = await readPlan(existing.filePath)
          action = 'updated'
        }
      } else {
        const title = opts.title || inferredTitle || artifactTitle(sourcePath) || 'Untitled'
        const now = new Date().toISOString()
        const meta = normalizeMeta({
          ...sourceMeta,
          id: generateId(),
          title,
          created: sourceMeta.created ?? now,
          updated: now,
          source: sourcePath,
        })
        const slug = await uniqueSlug(slugify(title))
        const filePath = planPath(slug)
        await writePlan(filePath, meta, canonicalBody)
        parsed = await readPlan(filePath)
        action = 'created'
      }

      return {
        ...await buildEnvelope(parsed),
        capture: { action, source: sourcePath, format: isHtml ? 'html' : 'markdown' },
      }
    })
    if (opts.json) {
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else {
      process.stdout.write(`Captured (${envelope.capture.action}): ${sourcePath} -> ${envelope.path}\n  id: ${envelope.id}\n  url: ${envelope.url}\n`)
    }
  } catch (err) {
    if (err.exitCode || err.code === 'ELOCKTIMEOUT') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(err.exitCode || EXIT.CONFLICT)
    }
    throw err
  }
}
