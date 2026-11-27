import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/check-client-bundle.mjs', import.meta.url))

async function check(files) {
  const dir = await mkdtemp(join(tmpdir(), 'client-bundle-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(join(dir, name, '..'), { recursive: true })
      await writeFile(join(dir, name), source)
    }
    return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('client bundle check passes clean assets', async () => {
  assert.equal((await check({ 'immutable/app.js': 'export const x = 1\n' })).status, 0)
})

test('client bundle check fails on source maps', async () => {
  const map = await check({ 'immutable/app.js': 'x()\n', 'immutable/app.js.map': '{}' })
  assert.equal(map.status, 1)
  assert.match(map.stderr, /app\.js\.map: source map/)
  const comment = await check({ 'immutable/app.js': 'x()\n//# sourceMappingURL=app.js.map\n' })
  assert.equal(comment.status, 1)
  assert.match(comment.stderr, /sourceMappingURL/)
})

test('client bundle check fails on server-only names', async () => {
  const result = await check({ 'immutable/app.js': 'const k = "DATABASE_URL"\n' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /DATABASE_URL/)
})
