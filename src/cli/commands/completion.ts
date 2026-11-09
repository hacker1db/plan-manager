// @ts-nocheck
import { EXIT } from '../exit.js'

// Single source of truth for per-subcommand flags, shared by the bash and zsh
// completion scripts. test/cli/completion.test.js asserts this table matches
// every flag documented in `plan --help`, so the two cannot drift.
const TRACKING_FLAGS = ['--if-revision', '--idempotency-key', '--actor', '--evidence', '--json']

export const SUBCOMMAND_FLAGS = {
  open: [],
  init: [],
  new: ['--format'],
  create: ['--title', '--stdin', '--file', '--format', '--json'],
  import: [],
  capture: ['--title', '--json'],
  list: ['--status', '--json'],
  search: ['--json'],
  show: ['--json'],
  edit: [],
  update: ['--stdin', '--file', '--if-revision', '--json'],
  status: [],
  archive: [],
  serve: ['--foreground', '--json'],
  doctor: ['--json'],
  auth: [],
  push: ['--all'],
  blocks: ['--json'],
  check: ['--json'],
  stage: ['--reason', ...TRACKING_FLAGS],
  session: ['--stdin', '--file', ...TRACKING_FLAGS],
  pr: ['--role', ...TRACKING_FLAGS],
  review: ['--decision', '--head', '--state', ...TRACKING_FLAGS],
  complete: ['--reason', '--no-pr-rationale', ...TRACKING_FLAGS],
  reopen: ['--stage', '--reason', ...TRACKING_FLAGS],
  completion: [],
}

function flagCases() {
  return Object.entries(SUBCOMMAND_FLAGS)
    .filter(([, flags]) => flags.length > 0)
    .map(([sub, flags]) => `      ${sub}) flags="${flags.join(' ')}" ;;`)
    .join('\n')
}

function completionBody() {
  return `_plan() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]}
  local cmds="${Object.keys(SUBCOMMAND_FLAGS).join(' ')}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "$cmds --help --version" -- "$cur")); return
  fi
  local sub=\${COMP_WORDS[1]}
  case "$prev" in
    --file) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    --status) COMPREPLY=($(compgen -W "active completed archived all" -- "$cur")); return ;;
    --format) COMPREPLY=($(compgen -W "md mdx" -- "$cur")); return ;;
    --role) COMPREPLY=($(compgen -W "implements partial followup supporting planning implementation review" -- "$cur")); return ;;
    --decision) COMPREPLY=($(compgen -W "approved changes_requested" -- "$cur")); return ;;
    --state) COMPREPLY=($(compgen -W "submitted requested approved changes_requested dismissed unknown" -- "$cur")); return ;;
    --stage) COMPREPLY=($(compgen -W "in_progress planning" -- "$cur")); return ;;
    --title|--if-revision|--actor|--idempotency-key|--reason|--evidence|--head|--no-pr-rationale) return ;;
  esac
  local flags=""
  case "$sub" in
${flagCases()}
  esac
  case "$cur" in
    --*) COMPREPLY=($(compgen -W "$flags" -- "$cur")); return ;;
    '')
      if [ "$sub" = list ]; then
        COMPREPLY=($(compgen -W "$flags" -- "$cur")); return
      fi ;;
  esac
  case "$sub" in
    import|capture|check) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -f -- "$cur")) ;;
    show|edit|update|status|archive|push|stage|complete|reopen)
      if [ "\${COMP_WORDS[1]}" = status ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "active completed archived" -- "$cur")); return
      fi
      if [ "\${COMP_WORDS[1]}" = stage ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "planning awaiting_plan_review in_progress awaiting_pr_review" -- "$cur")); return
      fi
      if [ "$COMP_CWORD" -eq 2 ]; then
        # Plan IDs come from frontmatter (imported, agent-written, or synced),
        # so they are untrusted. Never feed them to \`compgen -W\`, which word-
        # expands each candidate, so an id holding a command substitution would
        # run on Tab. Read them line by line and prefix-match literally instead.
        local _plan_id
        COMPREPLY=()
        while IFS= read -r _plan_id; do
          [ -n "$_plan_id" ] || continue
          case "$_plan_id" in "$cur"*) COMPREPLY+=("$_plan_id") ;; esac
        done < <(plan list --status all 2>/dev/null | awk '$0 != "No plans found." {print $1}')
        if [ "$sub" = push ]; then
          case "--all" in "$cur"*) COMPREPLY+=("--all") ;; esac
        fi
      fi ;;
    session) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "attach end" -- "$cur")) ;;
    review)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "record" -- "$cur"))
      [ "$COMP_CWORD" -eq 4 ] && COMPREPLY=($(compgen -W "plan pr" -- "$cur")) ;;
    pr) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "attach detach refresh" -- "$cur")) ;;
    auth) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "login logout status" -- "$cur")) ;;
    completion) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash zsh" -- "$cur")) ;;
  esac
}
complete -F _plan plan
`
}

function bashScript() {
  return `# plan bash completion — load with: eval "$(plan completion bash)"\n${completionBody()}`
}

function zshScript() {
  return `# plan zsh completion — load with: eval "$(plan completion zsh)"
autoload -U +X compinit && compinit
autoload -U +X bashcompinit && bashcompinit
${completionBody()}`
}

export async function cmdCompletion(args) {
  if (args[0] === 'bash') { process.stdout.write(bashScript()); return }
  if (args[0] === 'zsh') { process.stdout.write(zshScript()); return }
  process.stderr.write('Usage: plan completion <bash|zsh>\n')
  process.exit(EXIT.INVALID_INPUT)
}
