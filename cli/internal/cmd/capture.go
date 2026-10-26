package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

const maxArtifactBytes = 8 * 1024 * 1024

var (
	titleTag    = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title\s*>`)
	anyTag      = regexp.MustCompile(`<[^>]*>`)
	whitespace  = regexp.MustCompile(`\s+`)
	separators  = regexp.MustCompile(`[-_]+`)
	htmlExts    = []string{".html", ".htm"}
	markdownExt = []string{".md", ".markdown"}
)

func htmlTitle(raw string) string {
	m := titleTag.FindStringSubmatch(raw)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(whitespace.ReplaceAllString(html.UnescapeString(anyTag.ReplaceAllString(m[1], "")), " "))
}

func convertHTML(raw string) (string, error) {
	pandoc := os.Getenv("PLAN_PANDOC")
	if pandoc == "" {
		pandoc = "pandoc"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, pandoc, "--from=html", "--to=gfm-raw_html", "--wrap=none", "--strip-comments")
	c.Stdin = strings.NewReader(raw)
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	if err := c.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return "", exitcode.New(exitcode.DependencyUnavailable, "Pandoc is required to capture HTML artifacts (%s not found)", pandoc)
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", invalid("Error converting HTML artifact: %s", detail)
	}
	return stdout.String(), nil
}

func sameMeta(a, b plans.Meta) bool {
	return a.Title == b.Title && a.Status == b.Status && a.Source == b.Source && slices.Equal(a.Tags, b.Tags)
}

func sourceMatches(source string) []*plans.Plan {
	var out []*plans.Plan
	for _, f := range plans.AllPlanFiles() {
		p, err := plans.Read(f)
		if err != nil {
			continue
		}
		fileAbs, _ := filepath.Abs(f)
		srcAbs := ""
		if p.Meta.Source != "" {
			srcAbs, _ = filepath.Abs(p.Meta.Source)
		}
		if fileAbs == source || srcAbs == source {
			out = append(out, p)
		}
	}
	return out
}

type captureEnvelope struct {
	plans.Envelope
	Capture struct {
		Action string `json:"action"`
		Source string `json:"source"`
		Format string `json:"format"`
	} `json:"capture"`
}

// Capture imports or refreshes a plan from a Markdown or HTML artifact.
func Capture(source, titleOverride string) (*captureEnvelope, error) {
	src, _ := filepath.Abs(source)
	ext := strings.ToLower(filepath.Ext(src))
	isHTML := slices.Contains(htmlExts, ext)
	if !isHTML && !slices.Contains(markdownExt, ext) {
		return nil, invalid("plan capture accepts only Markdown or HTML artifacts")
	}
	if err := plans.InitStorage(); err != nil {
		return nil, err
	}
	return lock.With(plans.Home(), func() (*captureEnvelope, error) {
		info, err := os.Lstat(src)
		if err != nil {
			return nil, invalid("Error reading artifact: %s", err.Error())
		}
		if !info.Mode().IsRegular() {
			return nil, invalid("Artifact must be a regular Markdown or HTML file")
		}
		if info.Size() > maxArtifactBytes {
			return nil, invalid("Artifact exceeds %d bytes", maxArtifactBytes)
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return nil, invalid("Error reading artifact: %s", err.Error())
		}
		raw := string(data)
		converted := raw
		if isHTML {
			if converted, err = convertHTML(raw); err != nil {
				return nil, err
			}
		}
		fm, body := plans.ParseFrontmatter(converted)
		if !strings.HasPrefix(body, "\n") {
			body = "\n" + body
		}
		inferred, _ := fm.Str("title")
		if isHTML {
			inferred = htmlTitle(raw)
		}
		matches := sourceMatches(src)
		if len(matches) > 1 {
			ids := make([]string, len(matches))
			for i, m := range matches {
				ids[i] = m.Meta.ID
			}
			return nil, exitcode.New(exitcode.Ambiguous, "Artifact source is already associated with multiple plans: %s", strings.Join(ids, ", "))
		}

		var p *plans.Plan
		action := "created"
		if len(matches) == 1 {
			existing := matches[0]
			meta := existing.Meta
			if s, ok := fm.Str("status"); ok && plans.IsStatus(s) {
				meta.Status = s
			}
			if tags, ok := fm.List("tags"); ok {
				meta.Tags = tags
			}
			meta.Title = firstNonEmpty(titleOverride, inferred, existing.Meta.Title)
			meta.Source = src
			if existing.Body == body && sameMeta(existing.Meta, meta) {
				p, action = existing, "unchanged"
			} else {
				if err := plans.Write(existing.FilePath, meta, body); err != nil {
					return nil, err
				}
				if p, err = plans.Read(existing.FilePath); err != nil {
					return nil, err
				}
				action = "updated"
			}
		} else {
			meta := plans.NormalizeMeta(fm)
			meta.ID = plans.GenerateID()
			meta.Title = firstNonEmpty(titleOverride, inferred,
				strings.TrimSpace(separators.ReplaceAllString(strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)), " ")), "Untitled")
			meta.Updated = plans.Now()
			meta.Source = src
			dropForeignTracking(&meta)
			slug, err := plans.UniqueSlug(plans.Slugify(meta.Title))
			if err != nil {
				return nil, err
			}
			fp := plans.PlanPath(slug, "md")
			if err := plans.Write(fp, meta, body); err != nil {
				return nil, err
			}
			if p, err = plans.Read(fp); err != nil {
				return nil, err
			}
		}
		env := &captureEnvelope{Envelope: p.Envelope()}
		env.Capture.Action, env.Capture.Source, env.Capture.Format = action, src, "markdown"
		if isHTML {
			env.Capture.Format = "html"
		}
		return env, nil
	})
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func newCaptureCmd(opts *options) *cobra.Command {
	var title string
	c := &cobra.Command{
		Use:               "capture <artifact> [--title <title>]",
		Short:             "Capture an external Markdown or HTML file as a plan",
		ValidArgsFunction: completeMarkdownFiles("md", "markdown", "html", "htm"),
		RunE: func(c *cobra.Command, args []string) error {
			if len(args) == 0 {
				return invalid("artifact argument required\n  Usage: plan capture <artifact> [--title <title>] [--json]")
			}
			env, err := Capture(args[0], title)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), env)
			}
			fmt.Fprintf(c.OutOrStdout(), "Captured (%s): %s -> %s\n  id: %s\n  url: %s\n", env.Capture.Action, env.Capture.Source, env.Path, env.ID, env.URL)
			return nil
		},
	}
	c.Flags().StringVar(&title, "title", "", "override the plan title")
	_ = c.RegisterFlagCompletionFunc("title", cobra.NoFileCompletions)
	return c
}
