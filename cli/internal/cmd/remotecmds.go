package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/remote"
)

func newAuthCmd(opts *options) *cobra.Command {
	var token string
	var stdin bool
	c := &cobra.Command{
		Use:       "auth <login|logout|status>",
		Short:     "Sign in to the hosted site",
		Long:      "Sign in to the hosted Plan Manager site. PLAN_MANAGER_URL overrides the site URL.",
		ValidArgs: []cobra.Completion{"login\tSign in through the browser", "logout\tRemove the stored credential", "status\tShow whether you are signed in"},
		RunE: func(c *cobra.Command, args []string) error {
			sub := ""
			if len(args) > 0 {
				sub = args[0]
			}
			fail := func(err error) error { return invalid("%s", err.Error()) }
			site, err := remote.GetSite()
			if err != nil {
				return fail(err)
			}
			out := c.OutOrStdout()
			switch sub {
			case "login":
				if stdin || token != "" {
					if stdin {
						data, _ := io.ReadAll(os.Stdin)
						token = strings.TrimSpace(string(data))
					}
					if err := remote.StoreLegacyToken(token); err != nil {
						return fail(err)
					}
					if opts.json {
						return writeJSON(out, map[string]any{"site": site.URL, "credential": "configured", "type": "legacy"})
					}
					fmt.Fprintf(out, "Stored Plan Manager token for %s in macOS Keychain.\n", site.URL)
					return nil
				}
				if err := remote.Login(site, out); err != nil {
					return fail(err)
				}
				if opts.json {
					return writeJSON(out, map[string]any{"site": site.URL, "credential": "configured", "type": "clerk-oauth"})
				}
				return nil
			case "logout":
				if err := remote.RemoveToken(); err != nil {
					return fail(err)
				}
				if opts.json {
					return writeJSON(out, map[string]any{"site": site.URL, "credential": "removed"})
				}
				fmt.Fprintf(out, "Removed credential for %s.\n", site.URL)
				return nil
			case "status":
				_, err := remote.TokenFromKeychain()
				if opts.json {
					cred := "configured"
					if err != nil {
						cred = "missing"
					}
					return writeJSON(out, map[string]any{"version": 1, "site": site.URL, "credential": cred})
				}
				state := "signed in"
				if err != nil {
					state = "not signed in"
				}
				fmt.Fprintf(out, "%s: %s\n", site.URL, state)
				return nil
			}
			if sub == "" {
				sub = "(none)"
			}
			return invalid("Unknown auth subcommand: %s\nUsage: plan auth <login|logout|status>", sub)
		},
	}
	c.Flags().StringVar(&token, "token", "", "store a legacy pm_ token instead of signing in")
	c.Flags().BoolVar(&stdin, "stdin", false, "read a legacy token from stdin")
	_ = c.RegisterFlagCompletionFunc("token", cobra.NoFileCompletions)
	return c
}

func newPushCmd(opts *options) *cobra.Command {
	var all bool
	c := &cobra.Command{
		Use:               "push <id-or-slug|--all>",
		Short:             "Upload plans to the hosted site",
		ValidArgsFunction: completePlanArg(false),
		RunE: func(c *cobra.Command, args []string) error {
			if all == (len(args) > 0) {
				return invalid("Usage: plan push <id-or-slug|--all>")
			}
			results, err := PushPlans(args, all)
			if err != nil {
				code := exitcode.DependencyUnavailable
				if errors.Is(err, remote.ErrConflict) {
					code = exitcode.Conflict
				}
				msg := strings.TrimSuffix(err.Error(), ": "+remote.ErrConflict.Error())
				return &exitcode.Error{Code: code, Msg: msg}
			}
			site, _ := remote.GetSite()
			if opts.json {
				return writeJSON(c.OutOrStdout(), struct {
					Version int                 `json:"version"`
					Site    string              `json:"site"`
					Plans   []remote.PushResult `json:"plans"`
				}{1, site.URL, results})
			}
			for _, r := range results {
				fmt.Fprintf(c.OutOrStdout(), "Pushed %s: %s\n", r.ID, r.URL)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&all, "all", false, "push every plan in the plan home")
	return c
}

// PushPlans uploads the named plan, or every active-directory plan when all is set.
func PushPlans(args []string, all bool) ([]remote.PushResult, error) {
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	site, err := remote.GetSite()
	if err != nil {
		return nil, err
	}
	cfg, err := remote.LoadConfig(site)
	if err != nil {
		return nil, err
	}
	token, err := remote.TokenFromKeychain()
	if err != nil {
		return nil, err
	}
	var ids []string
	if all {
		for _, f := range plans.ListPlanFiles() {
			if p, err := plans.Read(f); err == nil {
				ids = append(ids, p.Meta.ID)
			}
		}
	} else {
		ids = args[:1]
	}
	results := []remote.PushResult{}
	for _, id := range ids {
		p, err := plans.Resolve(id)
		if err != nil {
			return nil, err
		}
		env := p.Envelope()
		var expected *string
		if rev, ok := cfg.Revisions[p.Meta.ID]; ok {
			expected = &rev
		}
		r, err := remote.Push(site, token, remote.PushPayload{
			ID: env.ID, Title: env.Title, Status: env.Status, Tags: env.Tags, Created: env.Created,
			Updated: env.Updated, Markdown: p.Raw, Revision: env.Revision, ExpectedRevision: expected,
		})
		if err != nil {
			return nil, err
		}
		cfg.Revisions[r.ID] = r.Revision
		results = append(results, r)
	}
	return results, remote.SaveConfig(cfg)
}
