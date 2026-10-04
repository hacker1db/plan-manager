import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

function planCmd(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function planAsync(args, env = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolvePromise({ status, stdout, stderr }))
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-capture-test-'))
  const planHome = join(root, 'plans')
  const pandoc = join(root, 'pandoc')
  await writeFile(pandoc, `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const text = input.replace(/<script[\\s\\S]*?<\\/script>/gi, '').replace(/<style[\\s\\S]*?<\\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim()
  process.stdout.write('# Captured\\n\\n' + text + '\\n')
})
`)
  await chmod(pandoc, 0o755)
  return {
    root,
    planHome,
    env: { PLAN_HOME: planHome, PLAN_PANDOC: pandoc },
  }
}

test('capture converts HTML to canonical Markdown and preserves the source', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'worktrunk-plan.html')
    const html = '<!doctype html><html><head><title>Worktrunk Plan</title><style>bad</style></head><body><h1>Worktrunk</h1><p>Review workflow</p><script>bad()</script></body></html>'
    await writeFile(source, html)
    const result = planCmd(['capture', source, '--json'], f.env)
    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.equal(envelope.title, 'Worktrunk Plan')
    assert.equal(envelope.capture.action, 'created')
    assert.equal(envelope.capture.format, 'html')
    assert.equal(envelope.capture.source, source)
    assert.match(await readFile(envelope.path, 'utf8'), /Review workflow/)
    assert.equal(await readFile(source, 'utf8'), html)
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('recapture is idempotent and updates the same ID and URL after source changes', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'release.html')
    await writeFile(source, '<html><head><title>Release</title></head><body>Version one</body></html>')
    const first = JSON.parse(planCmd(['capture', source, '--json'], f.env).stdout)
    const unchanged = JSON.parse(planCmd(['capture', source, '--json'], f.env).stdout)
    assert.equal(unchanged.capture.action, 'unchanged')
    assert.equal(unchanged.id, first.id)
    assert.equal(unchanged.url, first.url)
    assert.equal(unchanged.revision, first.revision)

    await writeFile(source, '<html><head><title>Release</title></head><body>Version two</body></html>')
    const updated = JSON.parse(planCmd(['capture', source, '--json'], f.env).stdout)
    assert.equal(updated.capture.action, 'updated')
    assert.equal(updated.id, first.id)
    assert.equal(updated.path, first.path)
    assert.equal(updated.url, first.url)
    assert.notEqual(updated.revision, first.revision)
    assert.match(await readFile(updated.path, 'utf8'), /Version two/)
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('capture imports Markdown with source metadata and leaves it unchanged', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'migration.md')
    const markdown = '---\ntitle: Migration Plan\ntags: [database]\n---\n\n# Steps\n\nCut over.\n'
    await writeFile(source, markdown)
    const result = planCmd(['capture', source, '--json'], f.env)
    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.equal(envelope.title, 'Migration Plan')
    assert.equal(envelope.capture.format, 'markdown')
    assert.equal(await readFile(source, 'utf8'), markdown)
    assert.match(await readFile(envelope.path, 'utf8'), new RegExp(`source: ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('capture normalizes unmanaged Markdown already inside plan home', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'seed.md'), '# Native Plan\n\nCreated by native plan mode.\n')
    const init = planCmd(['init', '--json'], f.env)
    assert.equal(init.status, 0, init.stderr)
    const source = join(f.planHome, 'native-plan.md')
    const markdown = '# Native Plan\n\nCreated by native plan mode.\n'
    await writeFile(source, markdown)
    const result = planCmd(['capture', source, '--title', 'Native Plan', '--json'], f.env)
    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.equal(envelope.path, source)
    assert.equal(envelope.capture.action, 'updated')
    assert.match(await readFile(source, 'utf8'), new RegExp(`id: ${envelope.id}`))
    const listed = JSON.parse(planCmd(['list', '--json'], f.env).stdout)
    assert.ok(listed.plans.some(plan => plan.id === envelope.id))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('in-library capture reads the source only after acquiring the writer lock', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.planHome, 'archive'), { recursive: true })
    const source = join(f.planHome, 'native-plan.md')
    await writeFile(source, '# Native Plan\n\nBefore lock wait.\n')
    const lockPath = join(f.planHome, '.write.lock')
    const lock = await open(lockPath, 'wx', 0o600)
    await lock.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() }))
    await lock.sync()

    const pending = planAsync(['capture', source, '--title', 'Native Plan', '--json'], f.env)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    await writeFile(source, '# Native Plan\n\nEdited while capture waited.\n')
    await lock.close()
    await unlink(lockPath)

    const result = await pending
    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout)
    assert.match(await readFile(envelope.path, 'utf8'), /Edited while capture waited/)
    assert.doesNotMatch(await readFile(envelope.path, 'utf8'), /Before lock wait/)
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('concurrent capture of one source returns one stable plan', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'concurrent.html')
    await writeFile(source, '<html><head><title>Concurrent</title></head><body>One plan</body></html>')
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      planAsync(['capture', source, '--json'], f.env)
    ))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 1)
    assert.equal(new Set(envelopes.map(envelope => envelope.url)).size, 1)
    assert.equal(envelopes.filter(envelope => envelope.capture.action === 'created').length, 1)
    const files = (await readdir(f.planHome)).filter(name => name.endsWith('.md'))
    assert.deepEqual(files, ['concurrent.md'])
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('concurrent capture of equal titles preserves both different sources', async () => {
  const f = await fixture()
  try {
    const firstSource = join(f.root, 'first.html')
    const secondSource = join(f.root, 'second.html')
    const page = body => `<html><head><title>Shared Title</title></head><body>${body}</body></html>`
    await writeFile(firstSource, page('First plan'))
    await writeFile(secondSource, page('Second plan'))
    const results = await Promise.all([
      planAsync(['capture', firstSource, '--json'], f.env),
      planAsync(['capture', secondSource, '--json'], f.env),
    ])
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 2)
    assert.equal(new Set(envelopes.map(envelope => envelope.path)).size, 2)
    const files = (await readdir(f.planHome)).filter(name => name.endsWith('.md')).sort()
    assert.deepEqual(files, ['shared-title-2.md', 'shared-title.md'])
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('concurrent create preserves every plan with the same title', async () => {
  const f = await fixture()
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      planAsync(['create', '--title', 'Race', '--json'], f.env)
    ))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 12)
    assert.equal(new Set(envelopes.map(envelope => envelope.path)).size, 12)
    assert.equal((await readdir(f.planHome)).filter(name => name.endsWith('.md')).length, 12)
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('concurrent writers recover one stale lock without losing mutual exclusion', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.planHome, 'archive'), { recursive: true })
    await writeFile(
      join(f.planHome, '.write.lock'),
      JSON.stringify({ pid: 2147483647, created: '2000-01-01T00:00:00.000Z' })
    )
    const results = await Promise.all(Array.from({ length: 30 }, () =>
      planAsync(['create', '--title', 'Stale Recovery', '--json'], f.env)
    ))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 30)
    assert.equal(new Set(envelopes.map(envelope => envelope.path)).size, 30)
    const files = await readdir(f.planHome)
    assert.equal(files.filter(name => name.endsWith('.md')).length, 30)
    assert.ok(!files.includes('.write.lock'))
    assert.ok(!files.includes('.write.lock.recovery'))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('a dead legacy recovery guard cannot block future writers', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.planHome, 'archive'), { recursive: true })
    const deadOwner = JSON.stringify({ pid: 2147483647, created: '2000-01-01T00:00:00.000Z' })
    await writeFile(join(f.planHome, '.write.lock'), deadOwner)
    await writeFile(join(f.planHome, '.write.lock.recovery'), deadOwner)
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      planAsync(['create', '--title', `Recovered Writer ${index}`, '--json'], f.env)
    ))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 30)
    assert.equal(new Set(envelopes.map(envelope => envelope.path)).size, 30)
    const files = await readdir(f.planHome)
    assert.equal(files.filter(name => name.endsWith('.md')).length, 30)
    assert.ok(!files.includes('.write.lock'))
    assert.ok(!files.includes('.write.lock.recovery'))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('mixed create import and capture preserve equal-title plans', async () => {
  const f = await fixture()
  try {
    const markdownSource = join(f.root, 'shared.md')
    const htmlSource = join(f.root, 'shared.html')
    await writeFile(markdownSource, '---\ntitle: Shared\n---\n\nImported body.\n')
    await writeFile(htmlSource, '<html><head><title>Shared</title></head><body>Captured body.</body></html>')
    const results = await Promise.all([
      planAsync(['create', '--title', 'Shared', '--json'], f.env),
      planAsync(['import', markdownSource, '--json'], f.env),
      planAsync(['capture', htmlSource, '--json'], f.env),
    ])
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const envelopes = results.map(result => JSON.parse(result.stdout))
    assert.equal(new Set(envelopes.map(envelope => envelope.id)).size, 3)
    assert.equal(new Set(envelopes.map(envelope => envelope.path)).size, 3)
    assert.equal((await readdir(f.planHome)).filter(name => name.endsWith('.md')).length, 3)
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('concurrent guarded updates allow one winner and reject stale writers', async () => {
  const f = await fixture()
  try {
    const createdResult = planCmd(['create', '--title', 'Guarded Update', '--json'], f.env)
    assert.equal(createdResult.status, 0, createdResult.stderr)
    const created = JSON.parse(createdResult.stdout)
    const updateFile = join(f.root, 'updated.md')
    await writeFile(updateFile, '# Guarded Update\n\nNew body.\n')
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      planAsync([
        'update',
        created.id,
        '--file',
        updateFile,
        '--if-revision',
        created.revision,
        '--json',
      ], f.env)
    ))
    assert.equal(results.filter(result => result.status === 0).length, 1)
    assert.equal(results.filter(result => result.status === 5).length, 11)
    for (const result of results.filter(item => item.status === 5)) {
      assert.equal(JSON.parse(result.stderr).error, 'conflict')
    }
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('capture rejects unsupported artifacts without creating a plan', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'notes.txt')
    await writeFile(source, 'not a plan')
    const result = planCmd(['capture', source, '--json'], f.env)
    assert.equal(result.status, 2)
    const files = await readdir(f.planHome).catch(() => [])
    assert.deepEqual(files.filter(name => name.endsWith('.md')), [])
    assert.ok(!files.includes('.write.lock'))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('capture reports unavailable Pandoc for HTML without creating a plan', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'plan.html')
    await writeFile(source, '<html><body>Plan</body></html>')
    const result = planCmd(['capture', source, '--json'], {
      PLAN_HOME: f.planHome,
      PLAN_PANDOC: join(f.root, 'missing-pandoc'),
    })
    assert.equal(result.status, 8)
    assert.match(result.stderr, /Pandoc is required/)
    const files = await readdir(f.planHome).catch(() => [])
    assert.deepEqual(files.filter(name => name.endsWith('.md')), [])
    assert.ok(!files.includes('.write.lock'))
  } finally {
    await rm(f.root, { recursive: true })
  }
})

test('import rejects HTML and preserves the artifact', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'legacy.html')
    const html = '<html><body>Legacy plan</body></html>'
    await writeFile(source, html)
    const result = planCmd(['import', source, '--json'], f.env)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /plan capture/)
    assert.equal(await readFile(source, 'utf8'), html)
    const files = await readdir(f.planHome).catch(() => [])
    assert.deepEqual(files, [])
  } finally {
    await rm(f.root, { recursive: true })
  }
})
