package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

// EditorCommand builds the command that opens path in $EDITOR, $VISUAL, or vi.
func EditorCommand(path string) *exec.Cmd {
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}
	if editor == "" {
		editor = "vi"
	}
	parts := strings.Fields(editor)
	return exec.Command(parts[0], append(parts[1:], path)...)
}

func runEditor(path string) (string, error) {
	c := EditorCommand(path)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Args[0], c.Run()
}

func readContent(useStdin bool, file string) (string, error) {
	if useStdin {
		data, err := io.ReadAll(os.Stdin)
		return string(data), err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", invalid("Error reading file: %s", err.Error())
	}
	return string(data), nil
}

func printCreated(c *cobra.Command, opts *options, label string, p *plans.Plan) error {
	if opts.json {
		return writeJSON(c.OutOrStdout(), p.Envelope())
	}
	env := p.Envelope()
	fmt.Fprintf(c.OutOrStdout(), "%s: %s\n  id: %s\n  url: %s\n", label, env.Path, env.ID, env.URL)
	return nil
}

// CreatePlan writes a new plan in format ("md" or "mdx") with a unique slug
// derived from its title.
func CreatePlan(meta plans.Meta, body, format string) (*plans.Plan, error) {
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	return lock.With(plans.Home(), func() (*plans.Plan, error) {
		slug, err := plans.UniqueSlug(plans.Slugify(meta.Title))
		if err != nil {
			return nil, err
		}
		fp := plans.PlanPath(slug, format)
		if err := plans.Write(fp, meta, body); err != nil {
			return nil, err
		}
		return plans.Read(fp)
	})
}

// requestedFormat validates --format, defaulting to fallback when unset.
func requestedFormat(format, fallback string) (string, error) {
	if format == "" {
		return fallback, nil
	}
	if !slices.Contains(plans.Formats, format) {
		return "", invalid("--format must be md or mdx")
	}
	return format, nil
}

func addFormatFlag(c *cobra.Command, format *string) {
	c.Flags().StringVar(format, "format", "", "plan format: md or mdx")
	_ = c.RegisterFlagCompletionFunc("format", cobra.FixedCompletions(
		[]cobra.Completion{"md\tMarkdown", "mdx\tMDX with typed review blocks"}, cobra.ShellCompDirectiveNoFileComp))
}

// dropForeignTracking clears tracking from metadata read from an outside
// file: its history is unverified provenance, so the new plan starts
// untracked.
func dropForeignTracking(meta *plans.Meta) {
	meta.Tracking, meta.SchemaVersion = nil, nil
}

func newMeta(title string) plans.Meta {
	now := plans.Now()
	return plans.Meta{ID: plans.GenerateID(), Title: title, Status: plans.StatusActive, Created: now, Updated: now, Tags: []string{}}
}

func newNewCmd(opts *options) *cobra.Command {
	var format string
	c := &cobra.Command{
		Use:   "new <title> [--format md|mdx]",
		Short: "Create a plan and open it in $EDITOR",
		RunE: func(c *cobra.Command, args []string) error {
			title := strings.TrimSpace(strings.Join(args, " "))
			if title == "" {
				return invalid("title required\n  Usage: plan new <title> [--format md|mdx]")
			}
			format, err := requestedFormat(format, "md")
			if err != nil {
				return err
			}
			p, err := CreatePlan(newMeta(title), "", format)
			if err != nil {
				return err
			}
			if name, err := runEditor(p.FilePath); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: could not open editor %q: %s\n", name, err)
			}
			if p, err = plans.Read(p.FilePath); err != nil {
				return err
			}
			return printCreated(c, opts, "Created", p)
		},
	}
	addFormatFlag(c, &format)
	return c
}

func newCreateCmd(opts *options) *cobra.Command {
	var title, file, format string
	var stdin bool
	c := &cobra.Command{
		Use:   "create --title <title> [--stdin|--file <file>] [--format md|mdx]",
		Short: "Create a plan non-interactively",
		RunE: func(c *cobra.Command, args []string) error {
			if title == "" {
				return invalid("--title is required\n  Usage: plan create --title <title> [--stdin|--file <file>] [--format md|mdx] [--json]")
			}
			fallback := "md"
			if file != "" {
				fallback = plans.FormatFromPath(file)
			}
			format, err := requestedFormat(format, fallback)
			if err != nil {
				return err
			}
			body := ""
			if stdin || file != "" {
				raw, err := readContent(stdin, file)
				if err != nil {
					return err
				}
				fm, b := plans.ParseFrontmatter(raw)
				body = raw
				if fm.Len() > 0 {
					body = b
				}
			}
			p, err := CreatePlan(newMeta(title), body, format)
			if err != nil {
				return err
			}
			return printCreated(c, opts, "Created", p)
		},
	}
	addFormatFlag(c, &format)
	c.Flags().StringVar(&title, "title", "", "plan title")
	c.Flags().BoolVar(&stdin, "stdin", false, "read the body from stdin")
	c.Flags().StringVar(&file, "file", "", "read the body from a file")
	_ = c.RegisterFlagCompletionFunc("title", cobra.NoFileCompletions)
	_ = c.MarkFlagFilename("file", "md", "mdx", "markdown", "txt")
	return c
}

func newImportCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "import <file>",
		Short:             "Import an existing Markdown or MDX file",
		ValidArgsFunction: completeMarkdownFiles("md", "mdx", "markdown"),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("file argument required\n  Usage: plan import <file>")
			}
			src, _ := filepath.Abs(args[0])
			ext := strings.ToLower(filepath.Ext(src))
			if ext != ".md" && ext != ".markdown" && ext != ".mdx" {
				return invalid("plan import accepts only Markdown or MDX files; use plan capture for HTML artifacts")
			}
			info, err := os.Lstat(src)
			if err != nil {
				return invalid("Error reading source file: %s", err.Error())
			}
			if !info.Mode().IsRegular() {
				return invalid("source must be a regular Markdown file")
			}
			data, err := os.ReadFile(src)
			if err != nil {
				return invalid("Error reading source file: %s", err.Error())
			}
			fm, body := plans.ParseFrontmatter(string(data))
			meta := plans.NormalizeMeta(fm)
			meta.ID = plans.GenerateID()
			if t, ok := fm.Str("title"); !ok || t == "" {
				meta.Title = strings.ReplaceAll(strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)), "-", " ")
			}
			meta.Source = src
			dropForeignTracking(&meta)
			format := plans.FormatFromPath(src)
			if meta.Format == "mdx" {
				format = "mdx"
			}
			p, err := CreatePlan(meta, body, format)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), p.Envelope())
			}
			env := p.Envelope()
			fmt.Fprintf(c.OutOrStdout(), "Imported: %s -> %s\n  id: %s\n  url: %s\n", src, env.Path, env.ID, env.URL)
			return nil
		},
	}
}

func newListCmd(opts *options) *cobra.Command {
	var status string
	c := &cobra.Command{
		Use:   "list [--status <active|completed|archived|all>]",
		Short: "List plans",
		RunE: func(c *cobra.Command, args []string) error {
			if err := plans.InitStorage(); err != nil {
				return err
			}
			list, err := ListPlans(status)
			if err != nil {
				return err
			}
			if opts.json {
				envs := make([]plans.Envelope, 0, len(list))
				for _, p := range list {
					envs = append(envs, p.Envelope())
				}
				return writeJSON(c.OutOrStdout(), struct {
					Version int              `json:"version"`
					Plans   []plans.Envelope `json:"plans"`
				}{1, envs})
			}
			if len(list) == 0 {
				fmt.Fprintln(c.OutOrStdout(), "No plans found.")
				return nil
			}
			pretty := stdoutIsTerminal()
			for _, p := range list {
				fmt.Fprintln(c.OutOrStdout(), formatListLine(p, pretty))
			}
			return nil
		},
	}
	c.Flags().StringVar(&status, "status", "", "filter by status")
	_ = c.RegisterFlagCompletionFunc("status", cobra.FixedCompletions(
		append(statusCandidates(), "all\tActive, completed, and archived"), cobra.ShellCompDirectiveNoFileComp))
	return c
}

// ListPlans returns plans filtered the same way `plan list --status` does:
// no status means the plan home only, "archived" means the archive
// directory, and "all" means both.
func ListPlans(status string) ([]*plans.Plan, error) {
	var files []string
	switch status {
	case plans.StatusArchived:
		files = plans.ListArchiveFiles()
	case "all":
		files = plans.AllPlanFiles()
	default:
		files = plans.ListPlanFiles()
	}
	var out []*plans.Plan
	for _, f := range files {
		p, err := plans.Read(f)
		if err != nil {
			continue
		}
		if status != "" && status != "all" && status != plans.StatusArchived && p.Meta.Status != status {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

func newSearchCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "search <query>",
		Short:             "Search titles, tags, and bodies",
		ValidArgsFunction: cobra.NoFileCompletions,
		RunE: func(c *cobra.Command, args []string) error {
			query := strings.ToLower(strings.TrimSpace(strings.Join(args, " ")))
			if query == "" {
				return invalid("query required\n  Usage: plan search <query> [--json]")
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			results := SearchPlans(query)
			if opts.json {
				envs := make([]plans.Envelope, 0, len(results))
				for _, p := range results {
					envs = append(envs, p.Envelope())
				}
				return writeJSON(c.OutOrStdout(), struct {
					Version int              `json:"version"`
					Query   string           `json:"query"`
					Plans   []plans.Envelope `json:"plans"`
				}{1, query, envs})
			}
			if len(results) == 0 {
				fmt.Fprintf(c.OutOrStdout(), "No plans match %q.\n", query)
				return nil
			}
			for _, p := range results {
				fmt.Fprintf(c.OutOrStdout(), "%s  %s\n", p.Meta.ID, p.Meta.Title)
			}
			return nil
		},
	}
}

// SearchPlans does a case-insensitive substring match on title, tags, and body.
func SearchPlans(query string) []*plans.Plan {
	query = strings.ToLower(query)
	var out []*plans.Plan
	for _, f := range plans.AllPlanFiles() {
		p, err := plans.Read(f)
		if err != nil {
			continue
		}
		hay := strings.ToLower(strings.Join(append(append([]string{p.Meta.Title}, p.Meta.Tags...), p.Body), " "))
		if strings.Contains(hay, query) {
			out = append(out, p)
		}
	}
	return out
}

func resolveContained(idOrSlug string) (*plans.Plan, error) {
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	p, err := plans.Resolve(idOrSlug)
	if err != nil {
		return nil, err
	}
	if !plans.Contained(p.FilePath) {
		return nil, exitcode.New(exitcode.PathTraversal, "path not contained in plan home")
	}
	return p, nil
}

func newShowCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "show <id-or-slug>",
		Short:             "Print a plan",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			id, err := pickPlan(args, "Show which plan?", true, invalid("id or slug required\n  Usage: plan show <id-or-slug> [--json]"))
			if err != nil {
				return err
			}
			p, err := resolveContained(id)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), struct {
					plans.Envelope
					Body string `json:"body"`
				}{p.Envelope(), p.Body})
			}
			if stdoutIsTerminal() {
				return renderShow(c.OutOrStdout(), p)
			}
			fmt.Fprintf(c.OutOrStdout(), "# %s\nid: %s  status: %s\nurl: %s\n\n%s\n", p.Meta.Title, p.Meta.ID, p.Meta.Status, p.Envelope().URL, p.Body)
			return nil
		},
	}
}

func newEditCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "edit <id-or-slug>",
		Short:             "Open a plan in $EDITOR",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			id, err := pickPlan(args, "Edit which plan?", true, invalid("id or slug required\n  Usage: plan edit <id-or-slug>"))
			if err != nil {
				return err
			}
			p, err := resolveContained(id)
			if err != nil {
				return err
			}
			if name, err := runEditor(p.FilePath); err != nil {
				return exitcode.New(exitcode.General, "could not open editor %q: %s", name, err)
			}
			return nil
		},
	}
}

func newUpdateCmd(opts *options) *cobra.Command {
	var file, ifRevision string
	var stdin bool
	c := &cobra.Command{
		Use:               "update <id-or-slug> [--stdin|--file <file>] [--if-revision <rev>]",
		Short:             "Replace a plan's body non-interactively",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("id or slug required\n  Usage: plan update <id-or-slug> [--stdin|--file <file>] [--if-revision <rev>] [--json]")
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			if !stdin && file == "" {
				return invalid("--stdin or --file required")
			}
			raw, err := readContent(stdin, file)
			if err != nil {
				return err
			}
			_, body := plans.ParseFrontmatter(raw)
			p, err := lock.With(plans.Home(), func() (*plans.Plan, error) {
				p, err := resolveContained(args[0])
				if err != nil {
					return nil, err
				}
				if ifRevision != "" && p.Revision() != ifRevision {
					return nil, &exitcode.Error{Code: exitcode.Conflict, Raw: true, Msg: conflictJSON(p.Revision(), ifRevision)}
				}
				if err := plans.Write(p.FilePath, p.Meta, body); err != nil {
					return nil, err
				}
				return plans.Read(p.FilePath)
			})
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), p.Envelope())
			}
			fmt.Fprintf(c.OutOrStdout(), "Updated: %s\n  revision: %s\n", p.FilePath, p.Revision())
			return nil
		},
	}
	c.Flags().BoolVar(&stdin, "stdin", false, "read the new body from stdin")
	c.Flags().StringVar(&file, "file", "", "read the new body from a file")
	c.Flags().StringVar(&ifRevision, "if-revision", "", "only write if the file still has this revision")
	_ = c.MarkFlagFilename("file", "md", "markdown", "txt")
	_ = c.RegisterFlagCompletionFunc("if-revision", func(c *cobra.Command, args []string, _ string) ([]cobra.Completion, cobra.ShellCompDirective) {
		if len(args) == 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		if p, err := plans.Resolve(args[0]); err == nil {
			return []string{p.Revision() + "\tcurrent revision"}, cobra.ShellCompDirectiveNoFileComp
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	})
	return c
}

func conflictJSON(current, supplied string) string {
	var b strings.Builder
	_ = writeJSON(&b, map[string]string{"error": "conflict", "currentRevision": current, "suppliedRevision": supplied})
	return strings.TrimSuffix(b.String(), "\n")
}

// SetStatus rewrites a plan's status under the write lock.
func SetStatus(idOrSlug, status string) (previous string, p *plans.Plan, err error) {
	p, err = lock.With(plans.Home(), func() (*plans.Plan, error) {
		cur, err := resolveContained(idOrSlug)
		if err != nil {
			return nil, err
		}
		previous = cur.Meta.Status
		meta := cur.Meta
		meta.Status = status
		if err := plans.Write(cur.FilePath, meta, cur.Body); err != nil {
			return nil, err
		}
		return plans.Read(cur.FilePath)
	})
	return previous, p, err
}

func newStatusCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "status <id-or-slug> <active|completed|archived>",
		Short: "Change a plan's status",
		ValidArgsFunction: func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			switch len(args) {
			case 0:
				return planCandidates(true), cobra.ShellCompDirectiveNoFileComp
			case 1:
				return statusCandidates(), cobra.ShellCompDirectiveNoFileComp
			}
			return nil, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(c *cobra.Command, args []string) error {
			usage := invalid("id/slug and status required\n  Usage: plan status <id-or-slug> <active|completed|archived>")
			id, err := pickPlan(args, "Change status of which plan?", true, usage)
			if err != nil {
				return err
			}
			var status string
			if len(args) > 1 {
				status = args[1]
			} else if status, err = pickStatus(usage); err != nil {
				return err
			}
			if !plans.IsStatus(status) {
				return invalid("invalid status %q (valid: active, completed, archived)", status)
			}
			if err := plans.InitStorage(); err != nil {
				return err
			}
			prev, p, err := SetStatus(id, status)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), p.Envelope())
			}
			fmt.Fprintf(c.OutOrStdout(), "Status updated: %s -> %s\n  %s\n", prev, status, p.FilePath)
			return nil
		},
	}
}

// ArchiveResult describes what ArchivePlan did.
type ArchiveResult struct {
	AlreadyArchived bool
	Source          string
	Destination     string
	Plan            *plans.Plan
}

// ArchivePlan marks a plan archived and moves it into the archive directory.
func ArchivePlan(idOrSlug string) (*ArchiveResult, error) {
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	return lock.With(plans.Home(), func() (*ArchiveResult, error) {
		p, err := resolveContained(idOrSlug)
		if err != nil {
			return nil, err
		}
		meta := p.Meta
		meta.Status = plans.StatusArchived
		if plans.IsArchivedPath(p.FilePath) {
			if p.Meta.Status != plans.StatusArchived {
				if err := plans.Write(p.FilePath, meta, p.Body); err != nil {
					return nil, err
				}
			}
			np, err := plans.Read(p.FilePath)
			return &ArchiveResult{AlreadyArchived: true, Source: p.FilePath, Plan: np}, err
		}
		dest, err := plans.UniqueArchivePath(plans.Slug(p.FilePath), plans.FormatFromPath(p.FilePath))
		if err != nil {
			return nil, err
		}
		if err := plans.Write(p.FilePath, meta, p.Body); err != nil {
			return nil, err
		}
		if err := os.Rename(p.FilePath, dest); err != nil {
			return nil, err
		}
		np, err := plans.Read(dest)
		return &ArchiveResult{Source: p.FilePath, Destination: dest, Plan: np}, err
	})
}

func newArchiveCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "archive <id-or-slug>",
		Short:             "Archive a plan and move it to archive/",
		ValidArgsFunction: completePlanArg(false),
		RunE: func(c *cobra.Command, args []string) error {
			id, err := pickPlan(args, "Archive which plan?", false, invalid("id or slug required\n  Usage: plan archive <id-or-slug>"))
			if err != nil {
				return err
			}
			r, err := ArchivePlan(id)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), r.Plan.Envelope())
			}
			if r.AlreadyArchived {
				fmt.Fprintf(c.OutOrStdout(), "Already archived: %s\n", r.Source)
			} else {
				fmt.Fprintf(c.OutOrStdout(), "Archived: %s -> %s\n", r.Source, r.Destination)
			}
			return nil
		},
	}
}
