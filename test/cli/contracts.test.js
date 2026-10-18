import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

function planCmd(args, env = {}, stdin) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...(stdin === undefined ? {} : { input: stdin }),
  })
}

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('archive preserves an existing destination and selects a collision-free filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-archive-contract-'))
  try {
    const created = planCmd(['create', '--title', 'Collision', '--stdin', '--json'], { PLAN_HOME: dir }, 'new plan\n')
    assert.equal(created.status, 0, created.stderr)
    const envelope = JSON.parse(created.stdout)
    const existing = join(dir, 'archive', 'collision.md')
    await writeFile(existing, 'existing archive')
    const archived = planCmd(['archive', envelope.id, '--json'], { PLAN_HOME: dir })
    assert.equal(archived.status, 0, archived.stderr)
    const result = JSON.parse(archived.stdout)
    assert.equal(await readFile(existing, 'utf8'), 'existing archive')
    assert.equal(result.path, join(dir, 'archive', 'collision-2.md'))
    assert.match(await readFile(result.path, 'utf8'), /new plan/)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('doctor reports service ownership, LaunchAgent, Codex override, and effective root access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-doctor-contract-'))
  try {
    const root = join(dir, 'plans')
    await mkdir(join(root, 'archive'), { recursive: true })
    await mkdir(join(dir, '.codex'), { recursive: true })
    await writeFile(join(dir, '.codex', 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = ["${root}"]\n`)
    await writeFile(join(dir, '.codex', 'AGENTS.override.md'), 'shadowing policy\n')
    const port = await freePort()
    const result = planCmd(['doctor', '--json'], {
      HOME: dir,
      PLAN_HOME: root,
      PLAN_PORT: String(port),
    })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.version, 1)
    assert.equal(report.serviceState, 'stopped')
    assert.equal(report.dashboardUrl, `http://plans.localhost:${port}`)
    assert.equal(report.planHome.access.status, 'ok')
    assert.equal(report.codex.configuredWritableRoot, true)
    assert.equal(report.codex.overrideConflict, true)
    assert.equal(report.launchAgent.label, 'com.plan-manager.serve')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('serve starts in the background, is idempotent, and open reuses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-serve-contract-'))
  const port = await freePort()
  let pid
  try {
    const env = { PLAN_HOME: dir, PLAN_PORT: String(port), PLAN_BROWSER: '/usr/bin/true' }
    const first = planCmd(['serve', '--json'], env)
    assert.equal(first.status, 0, first.stderr)
    const started = JSON.parse(first.stdout)
    pid = started.pid
    assert.equal(started.version, 1)
    assert.equal(started.serviceState, 'running')
    assert.equal(started.started, true)
    assert.equal(typeof pid, 'number')

    const second = planCmd(['serve', '--json'], env)
    assert.equal(second.status, 0, second.stderr)
    const running = JSON.parse(second.stdout)
    assert.equal(running.serviceState, 'running')
    assert.equal(running.started, false)

    const opened = planCmd(['open'], env)
    assert.equal(opened.status, 0, opened.stderr)
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch { }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    await rm(dir, { recursive: true })
  }
})

test('bare plan opens the hosted Plan Manager without starting a local service', async () => {
  const port = await freePort()
  const blocker = createServer()
  await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve))
  try {
    const result = planCmd([], { PLAN_PORT: String(port), PLAN_BROWSER: '/usr/bin/true' })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    await new Promise(resolve => blocker.close(resolve))
  }
})

test('pnpm dev serves the canonical plans.localhost URL from TypeScript source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-dev-contract-'))
  const port = await freePort()
  const child = spawn('pnpm', ['dev', '--', '--json'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, PLAN_HOME: dir, PLAN_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pnpm dev did not start: ${stderr}`)), 10000)
      child.stdout.on('data', () => {
        const line = stdout.split('\n').find(value => value.startsWith('{'))
        if (!line) return
        clearTimeout(timer)
        resolve(JSON.parse(line))
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`pnpm dev exited early (${code}): ${stderr}`))
      })
    })
    assert.equal(started.dashboardUrl, `http://plans.localhost:${port}`)
    const health = await fetch(`http://127.0.0.1:${port}/_health`, {
      headers: { Host: `plans.localhost:${port}` },
    }).then(response => response.json())
    assert.equal(health.url, `http://plans.localhost:${port}/`)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await rm(dir, { recursive: true })
  }
})

test('completion bash completes subcommands and plan ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-completion-'))
  try {
    const created = planCmd(['create', '--title', 'Tab target', '--stdin', '--json'], { PLAN_HOME: dir }, 'x\n')
    assert.equal(created.status, 0, created.stderr)
    const { id } = JSON.parse(created.stdout)
    const script = planCmd(['completion', 'bash']).stdout
    const shim = `plan() { "${process.execPath}" "${BIN}" "$@"; }\n${script}\n`
    const complete = words => spawnSync('bash', ['-c', `${shim}COMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]}-1)); _plan; printf '%s\\n' "\${COMPREPLY[@]}"`], { encoding: 'utf8', env: { ...process.env, PLAN_HOME: dir } }).stdout.split('\n')
    assert.deepEqual(complete("plan st").filter(Boolean).sort(), ['status'])
    assert.ok(complete("plan show ''").includes(id))
    assert.deepEqual(complete("plan status x c").filter(Boolean), ['completed'])
    assert.equal(planCmd(['completion', 'fish']).status, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
