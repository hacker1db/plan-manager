// @ts-nocheck
import { EXIT } from '../exit.js'

const BASH = `# plan bash completion — load with: eval "$(plan completion bash)"
_plan() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]}
  local cmds="open init new create import capture list search show edit update status archive serve doctor auth push blocks check completion stage session pr"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "$cmds --help --version" -- "$cur")); return
  fi
  case "$prev" in
    --file|import|capture|check) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    --status) COMPREPLY=($(compgen -W "active completed archived all" -- "$cur")); return ;;
    --format) COMPREPLY=($(compgen -W "md mdx" -- "$cur")); return ;;
    --role) COMPREPLY=($(compgen -W "implements partial followup supporting planning implementation review" -- "$cur")); return ;;
  esac
  case "\${COMP_WORDS[1]}" in
    show|edit|update|status|archive|push|stage)
      if [ "\${COMP_WORDS[1]}" = status ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "active completed archived" -- "$cur")); return
      fi
      if [ "\${COMP_WORDS[1]}" = stage ] && [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=($(compgen -W "planning awaiting_plan_review in_progress awaiting_pr_review completed" -- "$cur")); return
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
        case "--all" in "$cur"*) COMPREPLY+=("--all") ;; esac
      fi ;;
    session) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "attach end" -- "$cur")) ;;
    pr) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "attach detach refresh" -- "$cur")) ;;
    auth) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "login logout status" -- "$cur")) ;;
    completion) COMPREPLY=($(compgen -W "bash" -- "$cur")) ;;
    list) COMPREPLY=($(compgen -W "--status --json" -- "$cur")) ;;
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
