package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// bashCompat is appended to Cobra's bash script. Cobra's __start_plan needs
// _get_comp_words_by_ref from the bash-completion package, which a bare bash
// (macOS ships 3.2 without it) does not have, so sourcing the script there
// produced a completion that always failed. The fallback keeps it working,
// and registering the function name `_plan` (which the old TypeScript CLI's
// script used) keeps existing shell setups working.
const bashCompat = `
if ! declare -F _get_comp_words_by_ref >/dev/null 2>&1; then
    _get_comp_words_by_ref() {
        local arg
        for arg in "$@"; do
            case "$arg" in
                cur)   cur=${COMP_WORDS[COMP_CWORD]-} ;;
                prev)  if [ "$COMP_CWORD" -ge 1 ]; then prev=${COMP_WORDS[COMP_CWORD-1]}; else prev=""; fi ;;
                words) words=("${COMP_WORDS[@]}") ;;
                cword) cword=$COMP_CWORD ;;
            esac
        done
    }
fi
_plan() { __start_plan "$@"; }
if [[ $(type -t compopt) = "builtin" ]]; then
    complete -o default -F _plan plan
else
    complete -o default -o nospace -F _plan plan
fi
`

func newCompletionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "completion <shell>",
		Short: "Print a shell completion script",
		Long: `Print a completion script for bash, zsh, fish, or powershell.

  # zsh: add to ~/.zshrc (needs autoload -U compinit; compinit)
  source <(plan completion zsh)

  # bash
  source <(plan completion bash)

  # fish
  plan completion fish > ~/.config/fish/completions/plan.fish`,
		ValidArgs: []cobra.Completion{
			"bash\tBash (also loadable in zsh via bashcompinit)",
			"zsh\tZsh",
			"fish\tFish",
			"powershell\tPowerShell",
		},
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) != 1 {
				return invalid("usage: plan completion <bash|zsh|fish|powershell>")
			}
			root := c.Root()
			out := c.OutOrStdout()
			switch args[0] {
			case "bash":
				if err := root.GenBashCompletionV2(out, true); err != nil {
					return err
				}
				_, err := fmt.Fprint(out, bashCompat)
				return err
			case "zsh":
				return root.GenZshCompletion(out)
			case "fish":
				return root.GenFishCompletion(out, true)
			case "powershell":
				return root.GenPowerShellCompletionWithDesc(out)
			default:
				return invalid("unknown shell %q (bash, zsh, fish, powershell)", args[0])
			}
		},
	}
}
