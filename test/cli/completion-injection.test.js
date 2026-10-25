import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

// The bash completion script runs `plan list` and offers the printed ids as
// completions. Plan ids come from frontmatter (imported / agent-written /
// synced), so a crafted id must never be shell-expanded during completion.
// This drives the generated script with a fake `plan` whose `list` output
// carries a command-substitution payload and asserts (a) the payload is not
// executed and (b) it is still offered as a literal candidate.
test('bash completion does not execute command substitutions embedded in plan ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-completion-test-'))
  try {
    const sentinel = join(root, 'pwned')
    // No literal spaces: ${IFS} keeps the token a single awk field, and the
    // substitution would create the sentinel file if the id were expanded.
    const payload = `$(touch${'${IFS}'}${sentinel})`

    const binDir = join(root, 'bin')
    await mkdir(binDir, { recursive: true })
    const fakePlan = join(binDir, 'plan')
    await writeFile(fakePlan, `#!/usr/bin/env node
if (process.argv[2] === 'list') process.stdout.write(process.env.PAYLOAD + '\\tactive\\tTitle\\n')
`)
    await chmod(fakePlan, 0o755)

    const script = spawnSync(process.execPath, [BIN, 'completion', 'bash'], { encoding: 'utf8' })
    assert.equal(script.status, 0, script.stderr)
    const scriptPath = join(root, 'completion.bash')
    await writeFile(scriptPath, script.stdout)

    const driver = join(root, 'drive.bash')
    await writeFile(driver, `source "${scriptPath}"
COMP_WORDS=(plan show "")
COMP_CWORD=2
_plan
printf '%s\\n' "\${COMPREPLY[@]}"
`)

    const run = spawnSync('bash', [driver], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PAYLOAD: payload },
    })
    assert.equal(run.status, 0, run.stderr)

    // The security assertion: the substitution must not have run.
    await assert.rejects(stat(sentinel), { code: 'ENOENT' }, 'plan id was shell-expanded during completion')
    // Functional: the id is still offered, verbatim, plus --all.
    const replies = run.stdout.split('\n')
    assert.ok(replies.includes(payload), `expected literal candidate; got ${JSON.stringify(replies)}`)
    assert.ok(replies.includes('--all'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
