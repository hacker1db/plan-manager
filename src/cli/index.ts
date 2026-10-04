// @ts-nocheck
import { cmdInit } from './commands/init.js'
import { cmdNew } from './commands/new.js'
import { cmdCreate } from './commands/create.js'
import { cmdImport } from './commands/import.js'
import { cmdCapture } from './commands/capture.js'
import { cmdList } from './commands/list.js'
import { cmdSearch } from './commands/search.js'
import { cmdShow } from './commands/show.js'
import { cmdEdit } from './commands/edit.js'
import { cmdUpdate } from './commands/update.js'
import { cmdStatus } from './commands/status.js'
import { cmdArchive } from './commands/archive.js'
import { cmdServe } from './commands/serve.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdOpen } from './commands/open.js'
import { cmdRemote, cmdAuth, cmdPush } from './commands/remote.js'
import { EXIT } from './exit.js'

function parseArgs(argv) {
  const args = []
  const opts = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--json') { opts.json = true }
    else if (a === '--stdin') { opts.stdin = true }
    else if (a === '--foreground') { opts.foreground = true }
    else if (a === '--remote') { opts.remote = argv[++i] ?? true }
    else if (a === '--token') { opts.token = argv[++i] }
    else if (a === '--title') { opts.title = argv[++i] }
    else if (a === '--file') { opts.file = argv[++i] }
    else if (a === '--status') { opts.status = argv[++i] }
    else if (a === '--if-revision') { opts.ifRevision = argv[++i] }
    else if (a === '--all' || !a.startsWith('--')) { args.push(a) }
    i++
  }
  return { args, opts }
}

const VERSION = '0.3.0'

const USAGE = `plan — local Markdown plan manager

Usage:
  plan [open]                    Open the dashboard
  plan init                      Initialize plan home
  plan new <title>               Create a plan and open in $EDITOR
  plan create --title <title>    Create a plan non-interactively
    [--stdin|--file <file>] [--json]
  plan import <file>             Import an existing Markdown file
  plan capture <artifact>        Capture external Markdown or HTML
    [--title <title>] [--json]
  plan list [--status <s>] [--json]
  plan search <query> [--json]
  plan show <id-or-slug> [--json]
  plan edit <id-or-slug>
  plan update <id-or-slug>       Replace content non-interactively
    [--stdin|--file <file>] [--if-revision <rev>] [--json]
  plan status <id-or-slug> <active|completed|archived>
  plan archive <id-or-slug>
  plan serve [--foreground] [--json]
  plan doctor [--json]
  plan remote <add|list|status>
  plan auth <login|logout> <remote>
  plan push <id-or-slug|--all> [--remote <name>]

Exit codes:
  0  success
  2  invalid input
  3  not found
  4  ambiguous identifier
  5  revision conflict
  6  path traversal rejected
  7  storage unavailable
  8  dependency unavailable
  9  port collision
`

export async function run(argv) {
  const [cmd, ...rest] = argv
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(VERSION + '\n'); return }
  if (cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return }
  const { args, opts } = parseArgs(rest)
  switch (cmd) {
    case undefined: case 'open': return cmdOpen(args, opts)
    case 'init': return cmdInit(args, opts)
    case 'new': return cmdNew(args, opts)
    case 'create': return cmdCreate(args, opts)
    case 'import': return cmdImport(args, opts)
    case 'capture': return cmdCapture(args, opts)
    case 'list': return cmdList(args, opts)
    case 'search': return cmdSearch(args, opts)
    case 'show': return cmdShow(args, opts)
    case 'edit': return cmdEdit(args, opts)
    case 'update': return cmdUpdate(args, opts)
    case 'status': return cmdStatus(args, opts)
    case 'archive': return cmdArchive(args, opts)
    case 'serve': return cmdServe(args, opts)
    case 'doctor': return cmdDoctor(args, opts)
    case 'remote': return cmdRemote(args, opts)
    case 'auth': return cmdAuth(args, opts)
    case 'push': return cmdPush(args, opts)
    default: process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`); process.exit(EXIT.INVALID_INPUT)
  }
}
