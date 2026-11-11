package plans

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/ordered"
	"github.com/hacker1db/plan-manager/cli/internal/tracking"
)

func trackedMeta(t *testing.T, eventType string, data *ordered.Obj) Meta {
	t.Helper()
	meta := Meta{ID: "plan-1", Title: "Plan", Status: StatusActive, Created: "2026-01-01T00:00:00.000Z", Updated: "2026-01-01T00:00:00.000Z", Tags: []string{}}
	a, err := tracking.Append(meta.TrackingSource(), tracking.EventInput{Type: eventType, Data: data, Actor: "tester"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	v := tracking.SchemaVersion
	meta.Status, meta.SchemaVersion, meta.Tracking = a.Status, &v, a.Tracking.YAML()
	return meta
}

func TestTrackingFormatAndUnknownKeysSurviveRewrites(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	for _, name := range []string{"plan.md", "plan.mdx"} {
		fp := filepath.Join(Home(), name)
		meta := trackedMeta(t, "stage", ordered.New().Set("stage", "in_progress"))
		future, _ := ParseFrontmatter("---\nfutureField: {nested: [1, 2]}\n---\n")
		meta.Extra = NormalizeMeta(future).Extra
		if err := Write(fp, meta, "Body"); err != nil {
			t.Fatal(err)
		}
		first, err := Read(fp)
		if err != nil {
			t.Fatal(err)
		}
		if err := Write(fp, first.Meta, first.Body+"\n- [x] done"); err != nil {
			t.Fatal(err)
		}
		second, _ := Read(fp)
		if !strings.Contains(second.Raw, "futureField: {nested: [1, 2]}") {
			t.Errorf("%s lost an unknown key:\n%s", name, second.Raw)
		}
		if s := second.Envelope().Stage; s == nil || *s != "in_progress" {
			t.Errorf("%s stage = %v", name, s)
		}
		if strings.HasSuffix(name, ".mdx") != strings.Contains(second.Raw, "\nformat: mdx\n") {
			t.Errorf("%s format frontmatter:\n%s", name, second.Raw)
		}
	}
}

func TestNewerSchemaRefusesWrites(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	fp := filepath.Join(Home(), "plan.md")
	before := "---\nid: p\ntitle: P\nstatus: active\nschemaVersion: 99\ntracking: {events: []}\n---\nBody\n"
	if err := os.WriteFile(fp, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	p, _ := Read(fp)
	if p.Envelope().Stage != nil {
		t.Error("stage of an unsupported schema must be null")
	}
	err := Write(fp, p.Meta, "changed")
	if exitcode.CodeOf(err) != exitcode.InvalidInput || !strings.Contains(err.Error(), "tracking schema 99") {
		t.Errorf("write of schema 99: %v", err)
	}
	if after, _ := os.ReadFile(fp); string(after) != before {
		t.Error("refused write changed the file")
	}
}

func TestStatusMustAgreeWithTrackedStage(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	fp := filepath.Join(Home(), "plan.md")
	meta := trackedMeta(t, "completed", ordered.New().Set("reason", "done").Set("noPrRationale", "docs only").Set("coveredPrIds", []any{}))
	if meta.Status != StatusCompleted {
		t.Fatalf("completion status = %s", meta.Status)
	}
	meta.Status = StatusActive
	if err := Write(fp, meta, ""); exitcode.CodeOf(err) != exitcode.InvalidInput {
		t.Errorf("active while completed: %v", err)
	}
	meta.Status = StatusArchived
	if err := Write(fp, meta, ""); err != nil {
		t.Errorf("archived is a disposition: %v", err)
	}
}

func TestTooMuchUnknownFrontmatterRefusesWrites(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	var b strings.Builder
	b.WriteString("---\nid: p\ntitle: P\n")
	for i := range 101 {
		b.WriteString("k" + strings.Repeat("x", i) + ": 1\n")
	}
	b.WriteString("---\n")
	fm, _ := ParseFrontmatter(b.String())
	err := Write(filepath.Join(Home(), "plan.md"), NormalizeMeta(fm), "")
	if exitcode.CodeOf(err) != exitcode.InvalidInput || !strings.Contains(err.Error(), "unrecognized frontmatter") {
		t.Errorf("101 unknown keys: %v", err)
	}
}

func TestMDXStorage(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	if err := InitStorage(); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"visual.mdx":  "---\nid: mdx_plan_1\ntitle: Visual\n---\n<Callout>\nhi\n</Callout>\n",
		"notes.md":    "---\nid: md_plan_1\ntitle: Notes\n---\n# Notes\n",
		"ignored.txt": "nope",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(Home(), name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var names []string
	for _, f := range ListPlanFiles() {
		names = append(names, filepath.Base(f))
	}
	if strings.Join(names, ",") != "notes.md,visual.mdx" {
		t.Errorf("plan files = %v", names)
	}
	if slug, _ := UniqueSlug("visual"); slug != "visual-2" {
		t.Errorf("slugs are shared across formats: got %s", slug)
	}
	p, err := Resolve("visual")
	if err != nil || p.Meta.ID != "mdx_plan_1" || p.Meta.Format != "mdx" {
		t.Fatalf("resolve visual: %+v %v", p, err)
	}
	if err := Write(p.FilePath, p.Meta, p.Body); err != nil {
		t.Fatal(err)
	}
	if again, _ := Read(p.FilePath); !strings.Contains(again.Raw, "\nformat: mdx\n") {
		t.Errorf("rewritten MDX plan lacks format frontmatter:\n%s", again.Raw)
	}
	if notes, _ := Read(filepath.Join(Home(), "notes.md")); notes.Meta.Format != "" {
		t.Errorf("Markdown plan format = %q", notes.Meta.Format)
	}
	if dest, _ := UniqueArchivePath("visual", "mdx"); filepath.Base(dest) != "visual.mdx" {
		t.Errorf("archive path = %s", dest)
	}
}
