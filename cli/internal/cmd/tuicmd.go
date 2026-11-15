package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/tui"
)

func newTUICmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:     "tui",
		Aliases: []string{"ui"},
		Short:   "Browse and manage plans in an interactive terminal UI",
		RunE: func(c *cobra.Command, args []string) error {
			if !interactive() {
				return invalid("plan tui needs an interactive terminal")
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			self, err := os.Executable()
			if err != nil {
				return err
			}
			return tui.Run(tui.Backend{
				SetStatus: func(id, status string) error {
					_, _, err := SetStatus(id, status)
					return err
				},
				Archive: func(id string) error {
					_, err := ArchivePlan(id)
					return err
				},
				Create:     func(title string) (*plans.Plan, error) { return CreatePlan(newMeta(title), "", "md") },
				Complete:   Complete,
				EditorCmd:  func(path string) *exec.Cmd { return EditorCommand(path) },
				Executable: self,
			})
		},
	}
}

func formatListLine(p *plans.Plan, pretty bool) string {
	if pretty {
		return tui.ListLine(p.Meta.ID, p.Meta.Status, p.Meta.Title, p.Meta.Tags)
	}
	tags := ""
	if len(p.Meta.Tags) > 0 {
		tags = " [" + strings.Join(p.Meta.Tags, ", ") + "]"
	}
	return fmt.Sprintf("%s  %-10s  %s%s", p.Meta.ID, p.Meta.Status, p.Meta.Title, tags)
}

func renderShow(w io.Writer, p *plans.Plan) error {
	header := tui.ListLine(p.Meta.ID, p.Meta.Status, p.Meta.Title, p.Meta.Tags) + "\n" + p.Envelope().URL + "\n"
	body := p.Body
	if r, err := glamour.NewTermRenderer(glamour.WithAutoStyle(), glamour.WithWordWrap(100)); err == nil {
		if out, err := r.Render(p.Body); err == nil {
			body = out
		}
	}
	_, err := fmt.Fprint(w, header+body)
	return err
}

func pickStatus(usageErr error) (string, error) {
	if !interactive() {
		return "", usageErr
	}
	var items []tui.Suggestion
	for _, s := range statusCandidates() {
		v, d, _ := strings.Cut(s, "\t")
		items = append(items, tui.Suggestion{Value: v, Description: d})
	}
	choice, err := tui.Pick("New status?", items)
	if err != nil || choice == "" {
		return "", usageErr
	}
	return choice, nil
}
