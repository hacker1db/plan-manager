import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initStorage, listPlanFiles, resolveByIdOrSlug } from '../../lib/storage.js'
import { readPlan } from '../../lib/metadata.js'
import { buildEnvelope } from '../../lib/envelope.js'
import { EXIT } from '../exit.js'

type Remote = { name: string; url: string }
type RemoteConfig = { version: 1; remotes: Remote[]; revisions: Record<string, Record<string, string>> }

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plan-manager', 'remotes.json')
}

function keychainService(name: string): string {
  return `plan-manager:${name}`
}

function securityCommand(): string {
  return process.env.PLAN_MANAGER_SECURITY_COMMAND ?? '/usr/bin/security'
}

async function loadConfig(): Promise<RemoteConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as RemoteConfig
    if (parsed.version !== 1 || !Array.isArray(parsed.remotes)) throw new Error('invalid config')
    return { version: 1, remotes: parsed.remotes.filter(remote => typeof remote?.name === 'string' && typeof remote?.url === 'string'), revisions: parsed.revisions && typeof parsed.revisions === 'object' ? parsed.revisions : {} }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, remotes: [], revisions: {} }
    throw new Error(`Unable to read remote configuration: ${(error as Error).message}`)
  }
}

async function saveConfig(config: RemoteConfig): Promise<void> {
  const path = configPath()
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

function validRemoteUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Remote URL must be a bare https URL')
  return url.toString().replace(/\/$/, '')
}

function findRemote(config: RemoteConfig, name: string | boolean | undefined): Remote {
  const candidate = typeof name === 'string' ? name : config.remotes[0]?.name
  const remote = config.remotes.find(item => item.name === candidate)
  if (!remote) throw new Error('No remote is configured. Run "plan remote add <name> <https-url>" first.')
  return remote
}

function tokenFromKeychain(name: string): string {
  const result = spawnSync(securityCommand(), ['find-generic-password', '-a', 'plan-manager', '-s', keychainService(name), '-w'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`No credential for remote "${name}". Run "plan auth login ${name} --stdin".`)
  const token = result.stdout.trim()
  if (!/^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Stored credential has an invalid format')
  return token
}

function storeToken(name: string, token: string): void {
  if (!/^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Token format is invalid')
  const result = spawnSync(securityCommand(), ['add-generic-password', '-U', '-a', 'plan-manager', '-s', keychainService(name), '-w', token], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to store credential in macOS Keychain: ${result.stderr.trim()}`)
}

function removeToken(name: string): void {
  const result = spawnSync(securityCommand(), ['delete-generic-password', '-a', 'plan-manager', '-s', keychainService(name)], { encoding: 'utf8' })
  if (result.status !== 0 && !/could not be found/i.test(result.stderr)) throw new Error(`Unable to remove Keychain credential: ${result.stderr.trim()}`)
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', reject)
  })
}

function fail(message: string, code = EXIT.INVALID_INPUT): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(code)
}

export async function cmdRemote(args: string[], opts: { json?: boolean; remote?: string | boolean }): Promise<void> {
  const [sub, name, url] = args
  const config = await loadConfig()
  try {
    if (sub === 'add') {
      if (!name || !url || !/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) fail('Usage: plan remote add <name> <https-url>')
      const remote: Remote = { name, url: validRemoteUrl(url) }
      const index = config.remotes.findIndex(item => item.name === name)
      if (index >= 0) config.remotes[index] = remote
      else config.remotes.push(remote)
      await saveConfig(config)
      process.stdout.write(opts.json ? JSON.stringify(remote) + '\n' : `Configured remote ${name}: ${remote.url}\n`)
      return
    }
    if (sub === 'list') {
      process.stdout.write(opts.json ? JSON.stringify({ version: 1, remotes: config.remotes }) + '\n' : config.remotes.map(remote => `${remote.name}\t${remote.url}`).join('\n') + (config.remotes.length ? '\n' : ''))
      return
    }
    if (sub === 'status') {
      const remote = findRemote(config, name ?? opts.remote)
      let configured = false
      try { tokenFromKeychain(remote.name); configured = true } catch { }
      const result = { version: 1, remote, credential: configured ? 'configured' : 'missing' }
      process.stdout.write(opts.json ? JSON.stringify(result) + '\n' : `${remote.name}: ${configured ? 'credential configured' : 'credential missing'}\n`)
      return
    }
  } catch (error) { fail((error as Error).message) }
  fail(`Unknown remote subcommand: ${sub ?? '(none)'}\nUsage: plan remote <add|list|status>`)
}

export async function cmdAuth(args: string[], opts: { stdin?: boolean; token?: string; json?: boolean }): Promise<void> {
  const [sub, name] = args
  try {
    if (sub === 'login') {
      if (!name || (!opts.stdin && !opts.token)) fail('Usage: plan auth login <remote> (--stdin|--token <token>)')
      const remote = findRemote(await loadConfig(), name)
      const token = opts.stdin ? await readStdin() : opts.token!
      storeToken(remote.name, token)
      process.stdout.write(opts.json ? JSON.stringify({ remote: remote.name, credential: 'configured' }) + '\n' : `Stored credential for ${remote.name} in macOS Keychain.\n`)
      return
    }
    if (sub === 'logout') {
      if (!name) fail('Usage: plan auth logout <remote>')
      const remote = findRemote(await loadConfig(), name)
      removeToken(remote.name)
      process.stdout.write(opts.json ? JSON.stringify({ remote: remote.name, credential: 'removed' }) + '\n' : `Removed credential for ${remote.name}.\n`)
      return
    }
  } catch (error) { fail((error as Error).message) }
  fail(`Unknown auth subcommand: ${sub ?? '(none)'}\nUsage: plan auth <login|logout> <remote>`)
}

async function pushOne(remote: Remote, token: string, identifier: string, expectedRevision: string | null): Promise<{ id: string; url: string; revision: string }> {
  const resolved = await resolveByIdOrSlug(identifier)
  const parsed = await readPlan(resolved.filePath)
  const envelope = await buildEnvelope(parsed)
  const response = await fetch(`${remote.url}/api/v1/plans/${encodeURIComponent(envelope.id)}/versions`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id: envelope.id, title: envelope.title, status: envelope.status, tags: envelope.tags, created: envelope.created, updated: envelope.updated, markdown: parsed.raw, revision: envelope.revision, expectedRevision }),
  })
  const body = await response.json().catch(() => ({})) as { error?: string; currentRevision?: string; url?: string; plan?: { revision?: string } }
  if (response.status === 409) throw new Error(`Revision conflict for ${envelope.id}; remote is at ${body.currentRevision ?? 'an unknown revision'}`)
  if (!response.ok) throw new Error(`Push failed (${response.status}): ${body.error ?? 'unexpected response'}`)
  return { id: envelope.id, url: new URL(body.url ?? `/plans/${envelope.id}`, remote.url).toString(), revision: body.plan?.revision ?? envelope.revision }
}

export async function cmdPush(args: string[], opts: { json?: boolean; remote?: string | boolean }): Promise<void> {
  const identifier = args[0]
  if (!identifier) fail('Usage: plan push <id-or-slug|--all> [--remote <name>]')
  try {
    await initStorage()
    const config = await loadConfig()
    const remote = findRemote(config, opts.remote)
    const token = tokenFromKeychain(remote.name)
    const identifiers = identifier === '--all' ? await Promise.all((await listPlanFiles()).map(async path => (await readPlan(path)).meta.id)) : [identifier]
    const results = []
    for (const item of identifiers) {
      const result = await pushOne(remote, token, item, config.revisions[remote.name]?.[item] ?? null)
      config.revisions[remote.name] ??= {}
      config.revisions[remote.name][result.id] = result.revision
      results.push(result)
    }
    await saveConfig(config)
    process.stdout.write(opts.json ? JSON.stringify({ version: 1, remote: remote.name, plans: results }) + '\n' : results.map(result => `Pushed ${result.id}: ${result.url}`).join('\n') + '\n')
  } catch (error) { fail((error as Error).message, (error as Error).message.includes('Revision conflict') ? EXIT.CONFLICT : EXIT.DEPENDENCY_UNAVAILABLE) }
}
