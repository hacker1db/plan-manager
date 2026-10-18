// Package cmd defines the plan command tree.
package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
)

const Version = "0.3.0"

const longHelp = `plan — local Markdown plan manager

Plans are Markdown files with YAML frontmatter in $PLAN_HOME. Refer to a plan
by its ID or its filename slug. Run "plan tui" for the interactive manager.

Exit codes:
  0  success
  2  invalid input
  3  not found
  4  ambiguous identifier
  5  revision conflict
  6  path traversal rejected
  7  storage unavailable
  8  dependency unavailable
  9  port collision`

type options struct {
	json bool
}

// NewRoot builds a fresh command tree. A new tree per invocation keeps flag
// state isolated, which the TUI relies on when it asks for completions.
func NewRoot() *cobra.Command {
	opts := &options{}
	root := &cobra.Command{
		Use:           "plan",
		Short:         "Local Markdown plan manager",
		Long:          longHelp,
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		RunE: func(c *cobra.Command, args []string) error {
			return runOpen(c, opts, nil)
		},
	}
	root.SetVersionTemplate("{{.Version}}\n")
	root.Flags().BoolP("version", "v", false, "print the version")
	root.PersistentFlags().BoolVar(&opts.json, "json", false, "print machine-readable JSON")
	root.SetFlagErrorFunc(func(c *cobra.Command, err error) error {
		return &exitcode.Error{Code: exitcode.InvalidInput, Msg: err.Error() + "\n  Usage: " + c.UseLine()}
	})

	root.AddGroup(
		&cobra.Group{ID: "plans", Title: "Plans:"},
		&cobra.Group{ID: "service", Title: "Dashboard and setup:"},
		&cobra.Group{ID: "remote", Title: "Hosted site:"},
	)
	for _, c := range []*cobra.Command{
		newOpenCmd(opts), newTUICmd(opts),
		newNewCmd(opts), newCreateCmd(opts), newImportCmd(opts), newCaptureCmd(opts),
		newListCmd(opts), newSearchCmd(opts), newShowCmd(opts), newEditCmd(opts),
		newUpdateCmd(opts), newStatusCmd(opts), newArchiveCmd(opts),
	} {
		c.GroupID = "plans"
		root.AddCommand(c)
	}
	for _, c := range []*cobra.Command{newInitCmd(opts), newServeCmd(opts), newDoctorCmd(opts)} {
		c.GroupID = "service"
		root.AddCommand(c)
	}
	for _, c := range []*cobra.Command{newAuthCmd(opts), newPushCmd(opts)} {
		c.GroupID = "remote"
		root.AddCommand(c)
	}
	// Cobra's default completion command is replaced by one that fixes the
	// bash script for shells without the bash-completion package.
	root.CompletionOptions.DisableDefaultCmd = true
	root.AddCommand(newCompletionCmd())
	return root
}

// Execute runs the CLI and returns the process exit code.
func Execute(args []string) int {
	root := NewRoot()
	root.SetArgs(args)
	err := root.Execute()
	if err == nil {
		return exitcode.OK
	}
	code := exitcode.CodeOf(err)
	var e *exitcode.Error
	msg := err.Error()
	if errors.As(err, &e) && e.Raw {
		os.Stderr.WriteString(msg + "\n")
	} else {
		if code == exitcode.General && strings.HasPrefix(msg, "unknown command") {
			code = exitcode.InvalidInput
		}
		os.Stderr.WriteString("Error: " + msg + "\n")
	}
	return code
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func invalid(format string, args ...any) error {
	return exitcode.New(exitcode.InvalidInput, format, args...)
}

// interactive reports whether both stdin and stdout are terminals, so a
// missing argument can be filled in with a picker instead of failing.
func interactive() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

func stdoutIsTerminal() bool { return term.IsTerminal(int(os.Stdout.Fd())) }
