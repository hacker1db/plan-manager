import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

function planCmd(args, env = {}, stdin) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }
  if (stdin !== undefined) {
    opts.input = stdin
  }
  return spawnSync(process.execPath, [BIN, ...args], opts)
}

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-cli-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true })
  }
}

test('plan --version prints version', () => {
  const r = planCmd(['--version'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^\d+\.\d+\.\d+/)
})

test('plan create --title with --json returns envelope', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'My Test Plan', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const envelope = JSON.parse(r.stdout)
    assert.equal(envelope.version, 1)
    assert.equal(typeof envelope.id, 'string')
    assert.equal(envelope.title, 'My Test Plan')
    assert.equal(envelope.status, 'active')
    assert.ok(envelope.path.startsWith(dir))
    assert.match(envelope.url, /^http:\/\/plans\.localhost:\d+\/plans\//)
    assert.match(envelope.revision, /^[0-9a-f]{64}$/)
  })
})

test('plan create without --json reports the created path', async () => {
  await withHome(async dir => {
    const result = planCmd(['create', '--title', 'Plain Output'], { PLAN_HOME: dir })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`Created: ${dir}/plain-output\\.md`))
  })
})

test('plan create --title --stdin returns envelope', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'Stdin Plan', '--stdin', '--json'], { PLAN_HOME: dir }, 'Plan body from stdin\n')
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const envelope = JSON.parse(r.stdout)
    assert.equal(envelope.title, 'Stdin Plan')
  })
})

test('plan create without --title exits 2', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 2)
  })
})

test('plan list --json returns a versioned collection envelope', async () => {
  await withHome(async dir => {
    planCmd(['create', '--title', 'Plan A', '--json'], { PLAN_HOME: dir })
    planCmd(['create', '--title', 'Plan B', '--json'], { PLAN_HOME: dir })
    const r = planCmd(['list', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const list = JSON.parse(r.stdout)
    assert.equal(list.version, 1)
    assert.ok(Array.isArray(list.plans))
    assert.equal(list.plans.length, 2)
    assert.ok(list.plans.every(e => e.version === 1 && typeof e.id === 'string'))
  })
})

test('plan list --status filters by status', async () => {
  await withHome(async dir => {
    const r1 = planCmd(['create', '--title', 'Active Plan', '--json'], { PLAN_HOME: dir })
    const e1 = JSON.parse(r1.stdout)
    const slug = e1.path.replace(dir + '/', '').replace('.md', '')
    planCmd(['status', slug, 'completed'], { PLAN_HOME: dir })
    const active = JSON.parse(planCmd(['list', '--status', 'active', '--json'], { PLAN_HOME: dir }).stdout).plans
    const completed = JSON.parse(planCmd(['list', '--status', 'completed', '--json'], { PLAN_HOME: dir }).stdout).plans
    assert.equal(active.length, 0)
    assert.equal(completed.length, 1)
  })
})

test('plan update --if-revision succeeds on matching revision', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'Rev Plan', '--json'], { PLAN_HOME: dir })
    const envelope = JSON.parse(r.stdout)
    const slug = envelope.path.replace(dir + '/', '').replace('.md', '')
    const update = planCmd(
      ['update', slug, '--stdin', '--if-revision', envelope.revision, '--json'],
      { PLAN_HOME: dir },
      'Updated body\n'
    )
    assert.equal(update.status, 0, `stderr: ${update.stderr}`)
    const updated = JSON.parse(update.stdout)
    assert.equal(updated.id, envelope.id)
    assert.notEqual(updated.revision, envelope.revision)
  })
})

test('plan update --if-revision exits 5 on stale revision', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'Stale Plan', '--json'], { PLAN_HOME: dir })
    const envelope = JSON.parse(r.stdout)
    const slug = envelope.path.replace(dir + '/', '').replace('.md', '')
    const update = planCmd(
      ['update', slug, '--stdin', '--if-revision', 'deadbeef'.repeat(8), '--json'],
      { PLAN_HOME: dir },
      'New body\n'
    )
    assert.equal(update.status, 5)
    const errData = JSON.parse(update.stderr)
    assert.equal(errData.error, 'conflict')
    assert.ok(errData.currentRevision)
  })
})

test('plan show --json returns body field', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'Show Me', '--stdin', '--json'], { PLAN_HOME: dir }, 'body text\n')
    const envelope = JSON.parse(r.stdout)
    const show = planCmd(['show', envelope.id, '--json'], { PLAN_HOME: dir })
    assert.equal(show.status, 0, `stderr: ${show.stderr}`)
    const data = JSON.parse(show.stdout)
    assert.equal(data.id, envelope.id)
    assert.ok(data.body.includes('body text'))
  })
})

test('plan show with ambiguous slug exits 4 (same slug in root and archive)', async () => {
  await withHome(async dir => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'archive'), { recursive: true })
    const makeContent = (id) =>
      `---\nid: ${id}\ntitle: Clash\nstatus: active\ncreated: 2024-01-01T00:00:00.000Z\nupdated: 2024-01-01T00:00:00.000Z\ntags: []\n---\n\nbody\n`
    await writeFile(join(dir, 'clash.md'), makeContent('id-clash-1'))
    await writeFile(join(dir, 'archive', 'clash.md'), makeContent('id-clash-2'))
    const r = planCmd(['show', 'clash', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 4)
  })
})

test('plan archive moves plan to archive dir', async () => {
  await withHome(async dir => {
    const r = planCmd(['create', '--title', 'To Archive', '--json'], { PLAN_HOME: dir })
    const envelope = JSON.parse(r.stdout)
    const slug = envelope.path.replace(dir + '/', '').replace('.md', '')
    const arc = planCmd(['archive', slug, '--json'], { PLAN_HOME: dir })
    assert.equal(arc.status, 0, `stderr: ${arc.stderr}`)
    const arcEnv = JSON.parse(arc.stdout)
    assert.ok(arcEnv.path.includes('/archive/'))
    assert.equal(arcEnv.status, 'archived')
  })
})

test('plan search --json finds matching plans', async () => {
  await withHome(async dir => {
    planCmd(['create', '--title', 'Alpha Plan', '--stdin', '--json'], { PLAN_HOME: dir }, 'unique keyword xylophone\n')
    planCmd(['create', '--title', 'Beta Plan', '--json'], { PLAN_HOME: dir })
    const r = planCmd(['search', 'xylophone', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const results = JSON.parse(r.stdout)
    assert.equal(results.version, 1)
    assert.equal(results.query, 'xylophone')
    assert.equal(results.plans.length, 1)
    assert.equal(results.plans[0].title, 'Alpha Plan')
  })
})

test('plan doctor --json returns structured report', async () => {
  await withHome(async dir => {
    const r = planCmd(['doctor', '--json'], { PLAN_HOME: dir })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const report = JSON.parse(r.stdout)
    assert.equal(report.version, 1)
    assert.equal(report.dashboardUrl, 'http://plans.localhost:4173')
    assert.match(report.serviceState, /^(running|stopped|error)$/)
    assert.ok(report.planHome)
    assert.ok(report.node)
    assert.ok(report.launchAgent)
    assert.ok(report.codex)
  })
})

test('plan init creates directories', async () => {
  await withHome(async dir => {
    const subdir = join(dir, 'fresh')
    const r = planCmd(['init', '--json'], { PLAN_HOME: subdir })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const { stat } = await import('node:fs/promises')
    const s = await stat(join(subdir, 'archive'))
    assert.ok(s.isDirectory())
  })
})

test('plan auth status reports the single hosted site', async () => {
  await withHome(async dir => {
    const r = planCmd(['auth', 'status', '--json'], { HOME: dir, PLAN_MANAGER_URL: 'https://example.com', PLAN_MANAGER_SECURITY_COMMAND: '/usr/bin/false' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { version: 1, site: 'https://example.com', credential: 'missing' })
  })
})

test('plan rejects a non-https site URL', async () => {
  await withHome(async dir => {
    const r = planCmd(['auth', 'status'], { HOME: dir, PLAN_MANAGER_URL: 'http://example.com' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /PLAN_MANAGER_URL must be a bare https URL/)
  })
})

test('legacy pasted-token login explains the Clerk device-login replacement', async () => {
  await withHome(async dir => {
    const login = planCmd(['auth', 'login', '--token', 'not-a-plan-manager-token'], { HOME: dir })
    assert.equal(login.status, 2)
    assert.match(login.stderr, /Token format is invalid.*plan auth login/)
  })
})

test('plan push exits with dependency-unavailable', async () => {
  await withHome(async dir => {
    const r = planCmd(['push', 'some-plan'], { PLAN_HOME: dir })
    assert.equal(r.status, 8)
  })
})
