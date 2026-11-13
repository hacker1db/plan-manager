package cmd

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/usagecost"
)

// costSnapshot is a usage summary collected outside the write lock, plus the plan state it was
// collected for. Collection reads every tool log and can take seconds, so it must not hold the
// lock; apply re-checks plan identity and the linked sessions under the lock instead.
type costSnapshot struct {
	linked  plans.Meta
	summary *usagecost.Summary // nil when the plan has no linked sessions
}

// collectCost runs ai-usage for p's linked sessions, if any.
func collectCost(p *plans.Plan) (*costSnapshot, error) {
	refs, err := usagecost.Sessions(p.Meta)
	if err != nil {
		return nil, invalid("%s", err.Error())
	}
	snap := &costSnapshot{linked: p.Meta}
	if len(refs) == 0 {
		return snap, nil
	}
	if snap.summary, err = usagecost.Collect(context.Background(), refs); err != nil {
		return nil, err
	}
	return snap, nil
}

// errChanged is returned when the plan moved under a collection; retrying is always safe.
func errChanged() error {
	return exitcode.New(exitcode.Conflict, "plan changed while token usage was being collected; run the command again")
}

// resolveLocked re-resolves a plan by its immutable ID under the lock and refuses a different
// plan that now answers to the same name.
func resolveLocked(id string) (*plans.Plan, error) {
	cur, err := resolveContained(id)
	if err != nil {
		return nil, err
	}
	if cur.Meta.ID != id {
		return nil, errChanged()
	}
	return cur, nil
}

// apply writes the snapshot into meta and returns the new body. It refuses with a conflict when
// the plan or its linked sessions changed after collection, so a summary is never saved for the
// wrong plan or the wrong sessions.
func (c *costSnapshot) apply(cur *plans.Plan, meta *plans.Meta) (string, error) {
	if c == nil || cur.Meta.ID != c.linked.ID || !usagecost.SameSessions(c.linked, cur.Meta) {
		return "", errChanged()
	}
	if c.summary == nil {
		return cur.Body, nil
	}
	return usagecost.Apply(meta, cur.Body, c.summary, time.Now())
}

// needsCost reports whether moving p to status must record usage first: only a real transition
// into archived does. Relocating an already archived plan keeps the summary it has.
func needsCost(p *plans.Plan, status string, skipCost bool) bool {
	return !skipCost && status == plans.StatusArchived && p.Meta.Status != plans.StatusArchived
}

// withCostHint tells the user how to archive anyway when collection fails.
func withCostHint(err error) error {
	if err == nil {
		return nil
	}
	code := exitcode.CodeOf(err)
	if code == exitcode.General {
		code = exitcode.DependencyUnavailable
	}
	return exitcode.New(code, "could not record token usage: %s\n  Fix the cause, or pass --skip-cost to archive without a usage summary", err.Error())
}

func newUsageCmd(opts *options) *cobra.Command {
	root := &cobra.Command{
		Use:   "usage",
		Short: "Link AI sessions to a plan and total their tokens and estimated cost",
		Long: `Link AI sessions to a plan so "plan usage cost" and "plan archive" can total their usage.

A session is tool|profile|id as shown by the ai-usage dashboard (for example
claude-code|personal|638f2833-...), or a bare id that matches exactly one session.
Claude Code subagents are included in their parent session; a delegated Codex
or Copilot session is separate and must be linked on its own.

Archiving a plan (plan archive, plan status ... archived, the TUI, or the
dashboard) records the summary into the plan first. Numbers come from
"ai-usage plan-cost" (on PATH, or set PLAN_AI_USAGE_BIN).`,
	}
	mutate := func(use, short string, add bool) *cobra.Command {
		return &cobra.Command{
			Use:               use,
			Short:             short,
			ValidArgsFunction: completePlanArg(true),
			RunE: func(c *cobra.Command, args []string) error {
				if len(args) < 2 {
					return invalid("plan and at least one session required\n  Usage: plan usage %s", use)
				}
				refs := args[1:]
				for _, r := range refs {
					if err := usagecost.ValidateRef(r); err != nil {
						return invalid("%s", err.Error())
					}
				}
				if err := plans.InitStorage(); err != nil {
					return err
				}
				changed := 0
				p, err := lock.With(plans.Home(), func() (*plans.Plan, error) {
					cur, err := resolveContained(args[0])
					if err != nil {
						return nil, err
					}
					meta := cur.Meta
					if add {
						changed, err = usagecost.AddSessions(&meta, refs)
					} else {
						changed, err = usagecost.RemoveSessions(&meta, refs)
					}
					if err != nil {
						return nil, invalid("%s", err.Error())
					}
					if changed == 0 {
						return cur, nil
					}
					// A saved summary describes the old links; drop it rather than leave a
					// current-looking total for a different set of sessions.
					body, err := usagecost.Clear(&meta, cur.Body)
					if err != nil {
						return nil, err
					}
					if err := plans.Write(cur.FilePath, meta, body); err != nil {
						return nil, err
					}
					return plans.Read(cur.FilePath)
				})
				if err != nil {
					return err
				}
				return printSessions(c, opts, p, changed)
			},
		}
	}
	list := &cobra.Command{
		Use:               "ls <id-or-slug>",
		Short:             "List a plan's linked sessions",
		ValidArgsFunction: completePlanArg(false),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) != 1 {
				return invalid("plan required\n  Usage: plan usage ls <id-or-slug>")
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			p, err := resolveContained(args[0])
			if err != nil {
				return err
			}
			return printSessions(c, opts, p, -1)
		},
	}
	root.AddCommand(
		mutate("link <id-or-slug> <session>...", "Link sessions to a plan", true),
		mutate("unlink <id-or-slug> <session>...", "Unlink sessions from a plan", false),
		list,
		newCostCmd(opts),
	)
	return root
}

func printSessions(c *cobra.Command, opts *options, p *plans.Plan, changed int) error {
	refs, err := usagecost.Sessions(p.Meta)
	if err != nil {
		return invalid("%s", err.Error())
	}
	if refs == nil {
		refs = []string{}
	}
	if opts.json {
		out := map[string]any{"id": p.Meta.ID, "path": p.FilePath, "revision": p.Revision(), "sessions": refs}
		if changed >= 0 {
			out["changed"] = changed
		}
		return writeJSON(c.OutOrStdout(), out)
	}
	w := c.OutOrStdout()
	if changed >= 0 {
		fmt.Fprintf(w, "%d session(s) changed\n", changed)
	}
	if len(refs) == 0 {
		fmt.Fprintf(w, "No sessions linked to %s\n", p.Meta.ID)
		return nil
	}
	for _, r := range refs {
		fmt.Fprintln(w, r)
	}
	return nil
}

func newCostCmd(opts *options) *cobra.Command {
	var save bool
	c := &cobra.Command{
		Use:               "cost <id-or-slug> [--save]",
		Short:             "Total the tokens and estimated cost of a plan's linked sessions",
		ValidArgsFunction: completePlanArg(false),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) != 1 {
				return invalid("plan required\n  Usage: plan usage cost <id-or-slug> [--save] [--json]")
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			pre, err := resolveContained(args[0])
			if err != nil {
				return err
			}
			snap, err := collectCost(pre)
			if err != nil {
				return err
			}
			if snap.summary == nil {
				return exitcode.New(exitcode.InvalidInput, "no sessions linked to this plan\n  Link some with: plan usage link %s <session>...", args[0])
			}
			var saved *plans.Plan
			if save {
				saved, err = lock.With(plans.Home(), func() (*plans.Plan, error) {
					cur, err := resolveLocked(pre.Meta.ID)
					if err != nil {
						return nil, err
					}
					meta := cur.Meta
					body, err := snap.apply(cur, &meta)
					if err != nil {
						return nil, err
					}
					if err := plans.Write(cur.FilePath, meta, body); err != nil {
						return nil, err
					}
					return plans.Read(cur.FilePath)
				})
				if err != nil {
					return err
				}
			}
			if opts.json {
				out := map[string]any{"id": snap.linked.ID, "saved": saved != nil, "summary": snap.summary}
				if saved != nil {
					out["revision"] = saved.Revision()
					out["path"] = saved.FilePath
				}
				return writeJSON(c.OutOrStdout(), out)
			}
			printCost(c, snap.summary)
			if saved != nil {
				fmt.Fprintf(c.OutOrStdout(), "Saved to %s\n", saved.FilePath)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&save, "save", false, "write the summary into the plan")
	return c
}

func printCost(c *cobra.Command, s *usagecost.Summary) {
	w := c.OutOrStdout()
	var est string
	if s.EstimatedCostUSD != nil {
		est = fmt.Sprintf("$%.4f", *s.EstimatedCostUSD)
	} else {
		est = fmt.Sprintf("at least $%.4f (some usage unpriced)", s.PricedCostUSD)
	}
	fmt.Fprintf(w, "Sessions:   %d\nRequests:   %d\nTokens:     %d (input %d, cached %d, cache write %d, output %d)\nEst. cost:  %s\n",
		len(s.Sessions), s.Totals.Requests, s.Totals.Total, s.Totals.Input, s.Totals.Cached, s.Totals.CacheWrite, s.Totals.Output, est)
	if !s.Pricing.Loaded {
		fmt.Fprintf(w, "Pricing:    %s not found\n", s.Pricing.Path)
	}
	for _, l := range []struct {
		label string
		v     []string
	}{{"Missing", s.MissingSessions}, {"Unpriced", s.UnpricedModels}, {"Src errors", s.SourceErrors}} {
		if len(l.v) > 0 {
			fmt.Fprintf(w, "%-11s %s\n", l.label+":", strings.Join(l.v, ", "))
		}
	}
	if !s.Complete {
		fmt.Fprintln(w, "INCOMPLETE: figures are a lower bound")
	}
}
