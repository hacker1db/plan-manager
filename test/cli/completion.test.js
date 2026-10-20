import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const BIN = new URL('../../bin/plan', import.meta.url).pathname

function planCmd(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
}

// Parse `plan --help` into { subcommand: Set(flags) }, reading flags from each
// usage line and its indented continuation lines.
function flagsFromHelp(help) {
  const flags = {}
  let current = null
  for (const line of help.split('\n')) {
    if (/^Exit codes:/.test(line)) break
    const usage = line.match(/^  plan (\S+)/)
    if (usage) {
      current = usage[1].replace(/^\[(.+)\]$/, '$1')
      if (current.startsWith('<') || current.startsWith('--')) { current = null; continue }
      flags[current] ??= new Set()
    } else if (!/^ {3,}/.test(line)) {
      current = null
      continue
    }
    if (!current) continue
    for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) flags[current].add(flag)
  }
  return flags
}

// Parse the generated completion script into { subcommand: Set(flags) } from
// the `<sub>) flags="..."` case arms.
function flagsFromScript(script) {
  const flags = {}
  for (const match of script.matchAll(/^\s+([a-z]+)\) flags="([^"]*)" ;;$/gm)) {
    flags[match[1]] = new Set(match[2].split(' ').filter(Boolean))
  }
  return flags
}

function completeBash(script, words) {
  const invocation = `COMP_WORDS=(${words.map(word => `'${word}'`).join(' ')})
COMP_CWORD=${words.length - 1}
_plan
for reply in "\${COMPREPLY[@]}"; do printf '%s\\n' "$reply"; done`
  const result = spawnSync('bash', ['-c', `${script}\n${invocation}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split('\n').filter(Boolean).sort()
}

test('every flag in --help is completed for its subcommand, and nothing more', () => {
  const help = planCmd(['--help'])
  assert.equal(help.status, 0, help.stderr)
  const completion = planCmd(['completion', 'bash'])
  assert.equal(completion.status, 0, completion.stderr)

  const documented = flagsFromHelp(help.stdout)
  const completed = flagsFromScript(completion.stdout)

  const subcommands = completion.stdout.match(/local cmds="([^"]+)"/)[1].split(' ')
  assert.deepEqual(subcommands.sort(), Object.keys(documented).sort(), 'completion subcommand list matches --help')

  for (const [sub, flags] of Object.entries(documented)) {
    assert.deepEqual(
      [...(completed[sub] ?? new Set())].sort(),
      [...flags].sort(),
      `completion flags for "plan ${sub}" match --help`,
    )
  }
})

test('bash completion offers each subcommand flags at any position after the subcommand', () => {
  const script = planCmd(['completion', 'bash']).stdout
  assert.deepEqual(completeBash(script, ['plan', 'update', 'some-id', '--']), ['--file', '--if-revision', '--json', '--stdin'])
  assert.deepEqual(completeBash(script, ['plan', 'create', '--']), ['--file', '--json', '--stdin', '--title'])
  assert.deepEqual(completeBash(script, ['plan', 'push', 'some-id', '--a']), ['--all'])
  assert.deepEqual(completeBash(script, ['plan', 'serve', '--']), ['--foreground', '--json'])
  assert.deepEqual(completeBash(script, ['plan', 'doctor', '--j']), ['--json'])
  assert.deepEqual(completeBash(script, ['plan', 'edit', 'some-id', '--']), [])
  assert.deepEqual(completeBash(script, ['plan', 'list', '']), ['--json', '--status'])
  assert.deepEqual(completeBash(script, ['plan', 'list', '--json', '']), ['--json', '--status'])
})

test('value completion still works for --status and status positions', () => {
  const script = planCmd(['completion', 'bash']).stdout
  assert.deepEqual(completeBash(script, ['plan', 'list', '--status', '']), ['active', 'all', 'archived', 'completed'])
  assert.deepEqual(completeBash(script, ['plan', 'status', 'some-id', 'a']), ['active', 'archived'])
  assert.deepEqual(completeBash(script, ['plan', 'completion', '']), ['bash', 'zsh'])
})

test('zsh completion wraps the bash script with bashcompinit', () => {
  const result = planCmd(['completion', 'zsh'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /bashcompinit/)
  assert.match(result.stdout, /complete -F _plan plan/)
})

test('completion rejects unknown shells', () => {
  const result = planCmd(['completion', 'fish'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: plan completion <bash\|zsh>/)
})
