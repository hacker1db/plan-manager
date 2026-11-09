package cmd

import (
	"bytes"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/tui"
)

// planCandidates lists every plan as "<slug>\t<title> · <status>". Plans
// whose slug exists in both the plan home and the archive are offered by ID
// instead, since the slug alone would be ambiguous.
func planCandidates(includeArchived bool) []string {
	files := plans.ListPlanFiles()
	if includeArchived {
		files = append(files, plans.ListArchiveFiles()...)
	}
	count := map[string]int{}
	for _, f := range files {
		count[plans.Slug(f)]++
	}
	var out []string
	for _, f := range files {
		p, err := plans.Read(f)
		if err != nil {
			continue
		}
		key := plans.Slug(f)
		if count[key] > 1 {
			key = p.Meta.ID
		}
		out = append(out, key+"\t"+p.Meta.Title+" · "+p.Meta.Status)
	}
	return out
}

func completePlanArg(includeArchived bool) cobra.CompletionFunc {
	return func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return planCandidates(includeArchived), cobra.ShellCompDirectiveNoFileComp
	}
}

func statusCandidates() []string {
	return []string{
		"active\tIn progress",
		"completed\tDone, kept in the library",
		"archived\tMarked archived (use `plan archive` to also move the file)",
	}
}

func completeMarkdownFiles(exts ...string) cobra.CompletionFunc {
	return func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return exts, cobra.ShellCompDirectiveFilterFileExt
	}
}

// Complete returns completion suggestions for a partially typed command
// line, using exactly the same completion logic the shell scripts call.
func Complete(line string) []tui.Suggestion {
	words := strings.Fields(line)
	toComplete := ""
	if len(words) > 0 && !strings.HasSuffix(line, " ") {
		toComplete = words[len(words)-1]
		words = words[:len(words)-1]
	}
	root := NewRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(io.Discard)
	root.SetArgs(append(append([]string{cobra.ShellCompRequestCmd}, words...), toComplete))
	if err := root.Execute(); err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	var res []tui.Suggestion
	for _, l := range lines {
		if l == "" || strings.HasPrefix(l, ":") {
			continue
		}
		value, desc, _ := strings.Cut(l, "\t")
		if value == "help" || value == "completion" || value == "__complete" {
			continue
		}
		if toComplete != "" && !strings.HasPrefix(strings.ToLower(value), strings.ToLower(toComplete)) {
			continue
		}
		res = append(res, tui.Suggestion{Value: value, Description: desc})
	}
	return res
}

// pickPlan asks the user to choose a plan when an identifier is missing and
// the session is interactive; otherwise it returns usageErr.
func pickPlan(args []string, prompt string, includeArchived bool, usageErr error) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	if !interactive() {
		return "", usageErr
	}
	var items []tui.Suggestion
	for _, c := range planCandidates(includeArchived) {
		v, d, _ := strings.Cut(c, "\t")
		items = append(items, tui.Suggestion{Value: v, Description: d})
	}
	if len(items) == 0 {
		return "", usageErr
	}
	choice, err := tui.Pick(prompt, items)
	if err != nil || choice == "" {
		return "", usageErr
	}
	return choice, nil
}
