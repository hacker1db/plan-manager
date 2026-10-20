// @ts-nocheck
import { EXIT } from '../exit.js'

// Single source of truth for per-subcommand flags, shared by the bash and zsh
// completion scripts. test/cli/completion.test.js asserts this table matches
// every flag documented in `plan --help`, so the two cannot drift.
export const SUBCOMMAND_FLAGS = {
  open: [],
  init: [],
  new: [],
  create: ['--title', '--stdin', '--file', '--json'],
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
    --title|--if-revision) return ;;
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
    import|capture) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -f -- "$cur")) ;;
    show|edit|update|status|archive|push)
      if [ "$sub" = status ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "active completed archived" -- "$cur")); return
      fi
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "$(plan list --status all 2>/dev/null | awk '$0 != "No plans found." {print $1}')" -- "$cur")) ;;
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
