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
import { cmdAuth, cmdPush } from './commands/remote.js'
import { cmdCompletion } from './commands/completion.js'
import { cmdBlocks } from './commands/blocks.js'
import { cmdCheck } from './commands/check.js'
import { cmdSession, cmdPr, cmdStage, cmdReview, cmdComplete, cmdReopen, cmdHandoff, cmdHistory } from './commands/tracking.js'
import { EXIT } from './exit.js'
import { fileURLToPath } from 'node:url'
import { checkBuildFreshness, packageVersion } from '../lib/build.js'

function parseArgs(argv) {
  const args = []
  const opts = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--json') { opts.json = true }
    else if (a === '--stdin') { opts.stdin = true }
    else if (a === '--foreground') { opts.foreground = true }
    else if (a === '--token') { opts.token = argv[++i] }
    else if (a === '--title') { opts.title = argv[++i] }
    else if (a === '--file') { opts.file = argv[++i] }
    else if (a === '--format') { opts.format = argv[++i] }
    else if (a === '--status') { opts.status = argv[++i] }
    else if (a === '--if-revision') { opts.ifRevision = argv[++i] }
    else if (a === '--actor') { opts.actor = argv[++i] }
    else if (a === '--idempotency-key') { opts.idempotencyKey = argv[++i] }
    else if (a === '--role') { opts.role = argv[++i] }
    else if (a === '--reason') { opts.reason = argv[++i] }
    else if (a === '--evidence') { opts.evidence = argv[++i] }
    else if (a === '--decision') { opts.decision = argv[++i] }
    else if (a === '--state') { opts.state = argv[++i] }
    else if (a === '--head') { opts.head = argv[++i] }
    else if (a === '--no-pr-rationale') { opts.noPrRationale = argv[++i] }
    else if (a === '--stage') { opts.stage = argv[++i] }
    else if (a === '--scope') { opts.scope = argv[++i] }
    else if (a === '--end-previous') { opts.endPrevious = true }
    else if (a === '--activity') { opts.activity = argv[++i] }
    else if (a === '--owner') { opts.owner = argv[++i] }
    else if (a === '--next') { opts.next = argv[++i] }
    else if (a === '--observed-at') { opts.observedAt = argv[++i] }
    else if (a === '--all' || !a.startsWith('--')) { args.push(a) }
    i++
  }
  return { args, opts }
}

const DIST_DIR = fileURLToPath(new URL('..', import.meta.url))

const USAGE = `plan — local Markdown plan manager

Usage:
  plan [open]                    Open the dashboard
  plan init                      Initialize plan home
  plan new <title>               Create a plan and open in $EDITOR
    [--format md|mdx]
  plan create --title <title>    Create a plan non-interactively
    [--stdin|--file <file>] [--format md|mdx] [--json]
  plan import <file>             Import an existing Markdown or MDX file
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
  plan stage <id-or-slug> <stage> Move the plan's journey stage (guarded)
    [--reason <text>]            (planning, awaiting_plan_review, in_progress,
                                  awaiting_pr_review)
  plan review record <id-or-slug> plan --decision approved|changes_requested
                                 Review the submitted plan body revision
  plan review record <id-or-slug> pr <pr-url|pr-id> --head <sha>
    --state submitted|requested|approved|changes_requested|dismissed|unknown
  plan complete <id-or-slug> --reason <text> [--no-pr-rationale <text>]
                                 Complete after plan approval and merged, approved PRs
  plan reopen <id-or-slug> --stage in_progress|planning --reason <text>
  plan session attach <id-or-slug> --stdin|--file <json>
                                 Attach an agent session (provider, nativeSessionId,
                                 role, repository, worktree, branch, commit, environment)
  plan session end <id-or-slug> <execution-id>
  plan session lead <id-or-slug> <execution-id>
                                 Designate the one lead session (ending it leaves none)
  plan handoff <id-or-slug> <from-execution-id> <to-execution-id> --reason <text>
    [--scope <text>] [--end-previous]
                                 Hand work to another session; the lead moves with it
  plan session heartbeat <id-or-slug> <execution-id>
    [--activity active|idle|blocked] [--reason <text>] [--owner <text>]
    [--next <text>] [--observed-at <iso>]
                                 Report session health; blocked needs --reason and --owner
                                 (unchanged heartbeats within 5 minutes are coalesced)
  plan pr attach <id-or-slug> <pr-url> [--role implements|partial|followup|supporting]
  plan pr detach <id-or-slug> <pr-url|pr-id>
  plan pr refresh <id-or-slug> [pr-url|pr-id]
                                 Re-read PR state with gh
  plan history <id-or-slug> [--json]
                                 Show the plan's tracked events in order (read-only)
    Tracking commands accept [--if-revision <rev>] [--idempotency-key <key>]
    [--actor <name>] [--evidence <ref>] [--json]
  plan serve [--foreground] [--json]
  plan doctor [--json]
  plan auth login                Sign in to the hosted site in your browser
  plan auth <logout|status>
  plan push <id-or-slug|--all>   Upload plans to the hosted site
                                 (PLAN_MANAGER_URL overrides the site URL)
  plan blocks [--json]           Print the MDX plan block reference
  plan check <file|id>... [--json]
                                 Validate MDX plan blocks (exit 2 on errors)
  plan completion bash           Print shell completion script
                                 (add eval "$(plan completion bash)" to ~/.bashrc)

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
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(packageVersion() + '\n'); return }
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
    case 'auth': return cmdAuth(args, opts)
    case 'push': return cmdPush(args, opts)
    case 'blocks': return cmdBlocks(args, opts)
    case 'check': return cmdCheck(args, opts)
    case 'stage': return cmdStage(args, opts)
    case 'session': return cmdSession(args, opts)
    case 'pr': return cmdPr(args, opts)
    case 'review': return cmdReview(args, opts)
    case 'complete': return cmdComplete(args, opts)
    case 'reopen': return cmdReopen(args, opts)
    case 'handoff': return cmdHandoff(args, opts)
    case 'history': return cmdHistory(args, opts)
    case 'completion': return cmdCompletion(args)
    default: {
      const hint = checkBuildFreshness(DIST_DIR)?.stale ? 'This build is out of date; run pnpm build:cli.\n' : ''
      process.stderr.write(`Unknown command: ${cmd}\n${hint}\n${USAGE}`)
      process.exit(EXIT.INVALID_INPUT)
    }
  }
}
