// @ts-nocheck
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalize, resolve } from 'node:path'
import { getHost, getPlanHome, getPort } from './config.js'

const BIN = fileURLToPath(new URL('../../bin/plan', import.meta.url))

export function dashboardUrl(port = getPort()) {
  return `http://plans.localhost:${port}`
}

function healthRequest(port) {
  return new Promise(resolveRequest => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/_health',
      method: 'GET',
      headers: { Host: `plans.localhost:${port}` },
      timeout: 750,
    }, res => {
      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size <= 65536) chunks.push(chunk)
      })
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { }
        resolveRequest({ connected: true, statusCode: res.statusCode, body })
      })
    })
    req.on('timeout', () => req.destroy(new Error('health request timed out')))
    req.on('error', err => {
      if (err.code === 'ECONNREFUSED') {
        resolveRequest({ connected: false, error: err.message })
        return
      }
      resolveRequest({ connected: true, error: err.message })
    })
    req.end()
  })
}

export async function probeService(options = {}) {
  const port = options.port ?? getPort()
  const expectedPlanHome = options.planHome ?? getPlanHome()
  const response = await healthRequest(port)
  const url = dashboardUrl(port)
  if (!response.connected) {
    return { dashboardUrl: url, serviceState: 'stopped', owned: false, port }
  }
  const health = response.body
  const owned = response.statusCode === 200 &&
    health?.service === 'plan-manager' &&
    health?.version === 1 &&
    (health?.status === 'ok' || health?.status === 'degraded') &&
    typeof health?.planHome === 'string'
  if (!owned) {
    return {
      dashboardUrl: url,
      serviceState: 'error',
      owned: false,
      port,
      error: response.error ?? 'port is occupied by a service that is not plan-manager',
    }
  }
  if (normalize(resolve(health.planHome)) !== normalize(resolve(expectedPlanHome))) {
    return {
      dashboardUrl: url,
      serviceState: 'error',
      owned: true,
      port,
      health,
      error: `plan-manager is serving a different plan home: ${health.planHome}`,
    }
  }
  return {
    dashboardUrl: url,
    serviceState: 'running',
    owned: true,
    port,
    health,
  }
}

export async function ensureService(options = {}) {
  const port = options.port ?? getPort()
  const host = options.host ?? getHost()
  const planHome = options.planHome ?? getPlanHome()
  const current = await probeService({ port, planHome })
  if (current.serviceState === 'running') {
    return { ...current, started: false }
  }
  if (current.serviceState === 'error') {
    const err = new Error(current.error)
    err.code = 'EADDRINUSE'
    err.service = current
    throw err
  }

  const child = spawn(process.execPath, [BIN, 'serve', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PLAN_HOME: planHome,
      PLAN_PORT: String(port),
      PLAN_HOST: host,
    },
  })
  child.unref()

  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    const state = await probeService({ port, planHome })
    if (state.serviceState === 'running') {
      return { ...state, started: true, pid: child.pid }
    }
    if (state.serviceState === 'error') {
      const err = new Error(state.error)
      err.code = 'EADDRINUSE'
      err.service = state
      throw err
    }
  }

  const err = new Error(`plan-manager did not become healthy at ${dashboardUrl(port)}`)
  err.code = 'ESERVICEUNAVAILABLE'
  throw err
}
