// @ts-nocheck
import { EXIT } from '../exit.js'

const BASH = `# plan bash completion — load with: eval "$(plan completion bash)"
_plan() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]}
  local cmds="open init new create import capture list search show edit update status archive serve doctor auth push completion"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "$cmds --help --version --localhost" -- "$cur")); return
  fi
  case "$prev" in
    --file|import|capture) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    --status) COMPREPLY=($(compgen -W "active completed archived all" -- "$cur")); return ;;
  esac
  case "\${COMP_WORDS[1]}" in
    show|edit|update|status|archive|push)
      if [ "\${COMP_WORDS[1]}" = status ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "active completed archived" -- "$cur")); return
      fi
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "$(plan list --status all 2>/dev/null | awk '$0 != "No plans found." {print $1}') --all" -- "$cur")) ;;
    auth) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "login logout status" -- "$cur")) ;;
    completion) COMPREPLY=($(compgen -W "bash" -- "$cur")) ;;
    list) COMPREPLY=($(compgen -W "--status --json" -- "$cur")) ;;
    open) COMPREPLY=($(compgen -W "--localhost" -- "$cur")) ;;
  esac
}
complete -F _plan plan
`

export async function cmdCompletion(args) {
  if (args[0] !== 'bash') {
    process.stderr.write('Usage: plan completion bash\n  (zsh: autoload -U bashcompinit && bashcompinit first)\n')
    process.exit(EXIT.INVALID_INPUT)
  }
  process.stdout.write(BASH)
}
