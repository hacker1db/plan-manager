package cmd

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/mdx"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

func newBlocksCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "blocks",
		Short: "Print the MDX plan block reference",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, args []string) error {
			if opts.json {
				_, err := c.OutOrStdout().Write(mdx.CatalogJSON())
				return err
			}
			_, err := fmt.Fprint(c.OutOrStdout(), mdx.Reference())
			return err
		},
	}
}

// locateCheckTarget resolves a file path, or else a plan ID or slug.
func locateCheckTarget(target string) (string, error) {
	candidate, _ := filepath.Abs(target)
	info, err := os.Lstat(candidate)
	if err == nil && info.Mode().IsRegular() {
		return candidate, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := plans.InitStorage(); err != nil {
		return "", err
	}
	p, err := plans.Resolve(target)
	if err != nil {
		return "", err
	}
	return p.FilePath, nil
}

type checkResult struct {
	Path     string   `json:"path"`
	Format   string   `json:"format"`
	OK       bool     `json:"ok"`
	Problems []string `json:"problems"`
}

func newCheckCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "check <file|id-or-slug>...",
		Short: "Validate MDX plan blocks (exit 2 on errors)",
		ValidArgsFunction: func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return append(planCandidates(true), "mdx"), cobra.ShellCompDirectiveFilterFileExt
		},
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("file, id, or slug required\n  Usage: plan check <file|id-or-slug>... [--json]")
			}
			results := []checkResult{}
			for _, target := range args {
				path, err := locateCheckTarget(target)
				if err != nil {
					code := exitcode.NotFound
					if exitcode.CodeOf(err) == exitcode.Ambiguous {
						code = exitcode.Ambiguous
					}
					return exitcode.New(code, "%s", err.Error())
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				raw := string(data)
				result := checkResult{Path: path, Format: "md", Problems: []string{}}
				if plans.FormatFromPath(path) == "mdx" || mdx.SourceFormat(raw) == "mdx" {
					result.Format = "mdx"
					if problems := mdx.Check(mdx.StripFrontmatter(raw)); problems != nil {
						result.Problems = problems
					}
				}
				result.OK = len(result.Problems) == 0
				results = append(results, result)
			}
			if opts.json {
				if err := writeJSON(c.OutOrStdout(), struct {
					Version int           `json:"version"`
					Results []checkResult `json:"results"`
				}{1, results}); err != nil {
					return err
				}
			} else {
				for _, r := range results {
					status, note := "ok", ""
					if !r.OK {
						status = "FAIL"
					}
					if r.Format == "md" {
						note = " (Markdown, nothing to check)"
					}
					fmt.Fprintf(c.OutOrStdout(), "%s  %s%s\n", status, r.Path, note)
					for _, problem := range r.Problems {
						fmt.Fprintf(c.OutOrStdout(), "  - %s\n", problem)
					}
				}
			}
			for _, r := range results {
				if !r.OK {
					return &exitcode.Error{Code: exitcode.InvalidInput, Raw: true, Msg: ""}
				}
			}
			return nil
		},
	}
}
