import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { arch, hostname, platform } from 'node:os'
import { getConfigDir } from './config.js'
import { validateEnvironment, type EnvironmentIdentity, type MachineIdentity } from './tracking.js'

interface Installation { installationId: string; environmentId: string }

// shortcut: a copied config directory reuses the installation ID; detect clones (e.g. hostname drift) when backups make it happen.
async function installation(): Promise<Installation> {
  const path = join(getConfigDir(), 'installation.json')
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Installation
    validateEnvironment({ id: saved.installationId, type: 'host' })
    validateEnvironment({ id: saved.environmentId, type: 'host' })
    return saved
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Unreadable machine identity at ${path}; fix or remove it`)
  }
  const created = { installationId: randomUUID(), environmentId: randomUUID() }
  await mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, JSON.stringify(created, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return created
  } catch (err) {
    // Another process created it first; use theirs so one machine keeps one identity.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return JSON.parse(await readFile(path, 'utf8')) as Installation
    throw err
  }
}

export async function localMachine(): Promise<{ machine: MachineIdentity; host: EnvironmentIdentity }> {
  const { installationId, environmentId } = await installation()
  const observed = hostname()
  return {
    machine: { installationId, displayName: process.env.PLAN_MACHINE_NAME || observed, hostname: observed, os: platform(), arch: arch() },
    host: { id: environmentId, type: 'host' },
  }
}
