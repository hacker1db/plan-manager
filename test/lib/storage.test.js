import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite, containedPath, containedPathReal, initStorage, planHome, listPlanFiles, uniqueSlug } from '../../dist/lib/storage.js'

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-storage-test-'))
  process.env.PLAN_HOME = dir
  try {
    await fn(dir)
  } finally {
    delete process.env.PLAN_HOME
    await rm(dir, { recursive: true })
  }
}

test('initStorage creates root and archive', async () => {
  await withHome(async dir => {
    await initStorage()
    const { stat } = await import('node:fs/promises')
    const root = await stat(dir)
    const arc = await stat(join(dir, 'archive'))
    assert.ok(root.isDirectory())
    assert.ok(arc.isDirectory())
  })
})

test('initStorage throws ENOTDIR when path is a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-notdir-'))
  const filePath = join(dir, 'plans')
  await writeFile(filePath, 'not a dir')
  process.env.PLAN_HOME = filePath
  try {
    await assert.rejects(() => initStorage(), err => {
      assert.equal(err.code, 'ENOTDIR')
      return true
    })
  } finally {
    delete process.env.PLAN_HOME
    await rm(dir, { recursive: true })
  }
})

test('atomicWrite creates file with content', async () => {
  await withHome(async dir => {
    await initStorage()
    const fp = join(dir, 'test.md')
    await atomicWrite(fp, 'hello world')
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(fp, 'utf8')
    assert.equal(content, 'hello world')
  })
})

test('atomicWrite cleans up its same-directory temporary file on failure', async () => {
  await withHome(async dir => {
    await initStorage()
    const target = join(dir, 'blocked.md')
    await mkdir(target)
    await assert.rejects(() => atomicWrite(target, 'content'))
    const entries = await readdir(dir)
    assert.equal(entries.some(name => name.startsWith('.blocked.md.') && name.endsWith('.tmp')), false)
  })
})

test('containedPath returns true for files under planHome', async () => {
  await withHome(async dir => {
    assert.equal(containedPath(join(dir, 'plan.md')), true)
    assert.equal(containedPath(join(dir, 'archive', 'plan.md')), true)
  })
})

test('containedPath returns false for paths outside planHome', async () => {
  await withHome(async dir => {
    assert.equal(containedPath('/tmp/evil.md'), false)
    assert.equal(containedPath(join(dir, '..', 'evil.md')), false)
  })
})

test('managed reads and writes reject a symlinked Markdown file outside plan home', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'plan-storage-outside-'))
  await withHome(async dir => {
    await initStorage()
    const outsideFile = join(outside, 'outside.md')
    await writeFile(outsideFile, 'outside')
    const linked = join(dir, 'linked.md')
    await symlink(outsideFile, linked)
    assert.equal(containedPath(linked), false)
    assert.equal(await containedPathReal(linked), false)
    assert.deepEqual(await listPlanFiles(), [])
    await assert.rejects(() => atomicWrite(linked, 'changed'), err => {
      assert.equal(err.code, 'EPATHTRAVERSAL')
      return true
    })
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside')
  })
  await rm(outside, { recursive: true })
})

test('initStorage rejects a symlinked archive directory', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'plan-archive-outside-'))
  await withHome(async dir => {
    await symlink(outside, join(dir, 'archive'))
    await assert.rejects(() => initStorage(), err => {
      assert.equal(err.code, 'ENOTDIR')
      return true
    })
  })
  await rm(outside, { recursive: true })
})

test('listPlanFiles returns only .md files in root', async () => {
  await withHome(async dir => {
    await initStorage()
    await writeFile(join(dir, 'a.md'), '---\nid: a\ntitle: A\nstatus: active\ncreated: 2024-01-01T00:00:00.000Z\nupdated: 2024-01-01T00:00:00.000Z\ntags: []\n---\n')
    await writeFile(join(dir, 'b.txt'), 'not a plan')
    const files = await listPlanFiles()
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('a.md'))
  })
})

test('uniqueSlug returns base when free', async () => {
  await withHome(async dir => {
    await initStorage()
    const slug = await uniqueSlug('my-plan')
    assert.equal(slug, 'my-plan')
  })
})

test('uniqueSlug appends suffix on collision', async () => {
  await withHome(async dir => {
    await initStorage()
    await writeFile(join(dir, 'my-plan.md'), '')
    const slug = await uniqueSlug('my-plan')
    assert.equal(slug, 'my-plan-2')
  })
})
