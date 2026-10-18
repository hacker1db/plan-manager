// @ts-nocheck
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveDir, containedPathReal, planHome } from '../../lib/storage.js'
import { getPort } from '../../lib/config.js'
import { probeService } from '../../lib/service.js'
import { checkBuildFreshness } from '../../lib/build.js'

const DIST_DIR = fileURLToPath(new URL('../..', import.meta.url))

function checkBuild() {
  const freshness = checkBuildFreshness(DIST_DIR)
  if (!freshness) return { path: DIST_DIR, status: 'skipped' }
  return { path: DIST_DIR, status: freshness.stale ? 'stale' : 'ok', ...(freshness.reason ? { reason: freshness.reason } : {}) }
}

async function checkDir(path) {
  try {
    const s = await stat(path)
    return s.isDirectory() ? 'ok' : 'not-a-directory'
  } catch {
    return 'missing'
  }
}

function checkPandoc() {
  const result = spawnSync('pandoc', ['--version'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return { ok: false, version: null }
  const match = result.stdout.match(/^pandoc\s+([\d.]+)/m)
  return { ok: true, version: match ? match[1] : 'unknown' }
}

async function checkAccess(path) {
  const result = { readable: false, writable: false, contained: false, status: 'unavailable' }
  try {
    await access(path, constants.R_OK)
    result.readable = true
  } catch { }
  try {
    await access(path, constants.W_OK)
    result.writable = true
  } catch { }
  result.contained = await containedPathReal(path)
  if (result.readable && result.writable && result.contained) result.status = 'ok'
  return result
}

function parseWritableRoots(text) {
  const section = text.match(/^\[sandbox_workspace_write\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? ''
  const value = section.match(/^\s*writable_roots\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? ''
  const roots = []
  const pattern = /"((?:\\.|[^"])*)"|'([^']*)'/g
  let match
  while ((match = pattern.exec(value)) !== null) {
    if (match[1] !== undefined) {
      try { roots.push(JSON.parse(`"${match[1]}"`)) } catch { }
    } else {
      roots.push(match[2])
    }
  }
  return roots
}

async function checkCodex(root, home) {
  const configPath = join(home, '.codex', 'config.toml')
  const overridePath = join(home, '.codex', 'AGENTS.override.md')
  let config = ''
  let override = ''
  try { config = await readFile(configPath, 'utf8') } catch { }
  try { override = await readFile(overridePath, 'utf8') } catch { }
  const resolvedRoot = normalize(resolve(root))
  const writableRoots = parseWritableRoots(config)
  return {
    configPath,
    configuredWritableRoot: writableRoots.some(item => normalize(resolve(item.replace(/^~(?=\/|$)/, home))) === resolvedRoot),
    writableRoots,
    overridePath,
    overrideConflict: override.trim().length > 0,
  }
}

async function checkLaunchAgent(home) {
  const label = 'com.plan-manager.serve'
  const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  let installed = false
  try {
    installed = (await stat(path)).isFile()
  } catch { }
  if (process.platform !== 'darwin') {
    return { label, path, installed, loaded: false, state: installed ? 'unavailable' : 'missing' }
  }
  const domain = typeof process.getuid === 'function' ? `gui/${process.getuid()}/${label}` : label
  const result = spawnSync('launchctl', ['print', domain], { encoding: 'utf8' })
  if (result.status !== 0) {
    return { label, path, installed, loaded: false, state: installed ? 'unloaded' : 'missing' }
  }
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? 'loaded'
  const pid = Number(result.stdout.match(/\bpid = (\d+)/)?.[1] ?? 0)
  return { label, path, installed, loaded: true, state, ...(pid ? { pid } : {}) }
}

export async function cmdDoctor(args, opts) {
  const port = getPort()
  const root = planHome()
  const archive = archiveDir()
  const home = process.env.HOME || homedir()
  const [rootStatus, archiveStatus, rootAccess, service, launchAgent, codex] = await Promise.all([
    checkDir(root),
    checkDir(archive),
    checkAccess(root),
    probeService({ port, planHome: root }),
    checkLaunchAgent(home),
    checkCodex(root, home),
  ])
  const pandoc = checkPandoc()
  const build = checkBuild()
  const report = {
    version: 1,
    dashboardUrl: service.dashboardUrl,
    serviceState: service.serviceState,
    service,
    planHome: { path: root, status: rootStatus, access: rootAccess },
    archiveDir: { path: archive, status: archiveStatus },
    node: { ok: true, version: process.version },
    pandoc,
    build,
    launchAgent,
    codex,
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n')
    return
  }
  process.stdout.write(`Plan home:    ${root} [${rootStatus}; access ${rootAccess.status}]\n`)
  process.stdout.write(`Archive dir:  ${archive} [${archiveStatus}]\n`)
  process.stdout.write(`Node.js:      ${report.node.version} [ok]\n`)
  process.stdout.write(`Pandoc:       ${pandoc.ok ? pandoc.version : 'not found'} [${pandoc.ok ? 'ok' : 'missing'}]\n`)
  process.stdout.write(`CLI build:    ${build.path} [${build.status === 'stale' ? 'stale — run pnpm build:cli' : build.status}]\n`)
  process.stdout.write(`Dashboard:    ${report.dashboardUrl} [${report.serviceState}]\n`)
  process.stdout.write(`LaunchAgent:  ${launchAgent.label} [${launchAgent.state}]\n`)
  process.stdout.write(`Codex root:   ${codex.configuredWritableRoot ? 'configured' : 'missing'}\n`)
  process.stdout.write(`Codex policy: ${codex.overrideConflict ? 'shadowed by AGENTS.override.md' : 'ok'}\n`)
}
