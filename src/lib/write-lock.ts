// @ts-nocheck
import { lstat, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { planHome } from './storage.js'

const LOCK_TIMEOUT_MS = 10000
const STALE_LOCK_MS = 60000

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function lockIsStale(lockPath) {
  try {
    const state = JSON.parse(await readFile(lockPath, 'utf8'))
    if (Number.isInteger(state.pid) && state.pid > 0) {
      try {
        process.kill(state.pid, 0)
        return false
      } catch (err) {
        if (err.code === 'ESRCH') return true
        return false
      }
    }
  } catch {
  }
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > STALE_LOCK_MS
  } catch {
    return true
  }
}

async function removeStaleLegacyFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || !(await lockIsStale(path))) return false
    await unlink(path)
    return true
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EPERM') return false
    throw err
  }
}

async function waitForLegacyRecovery(lockPath, deadline) {
  const recoveryPath = `${lockPath}.recovery`
  while (true) {
    if (await removeStaleLegacyFile(recoveryPath)) return
    try {
      await lstat(recoveryPath)
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    if (Date.now() >= deadline) {
      const lockError = new Error('Timed out waiting for plan write-lock recovery to finish')
      lockError.code = 'ELOCKTIMEOUT'
      throw lockError
    }
    await sleep(25)
  }
}

async function acquirePlanWriteLock(root) {
  const lockPath = join(root, '.write.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  await waitForLegacyRecovery(lockPath, deadline)
  await removeStaleLegacyFile(lockPath)
  try {
    return await lockfile.lock(root, {
      lockfilePath: lockPath,
      realpath: false,
      stale: STALE_LOCK_MS,
      update: 10000,
      retries: {
        retries: Math.ceil(Math.max(0, deadline - Date.now()) / 25),
        factor: 1,
        minTimeout: 25,
        maxTimeout: 25,
        randomize: true,
      },
    })
  } catch (err) {
    if (err.code !== 'ELOCKED') throw err
    const lockError = new Error('Timed out waiting for another plan write to finish')
    lockError.code = 'ELOCKTIMEOUT'
    throw lockError
  }
}

export async function withPlanWriteLock(operation, root = planHome()) {
  const release = await acquirePlanWriteLock(root)
  try {
    return await operation()
  } finally {
    await release()
  }
}
