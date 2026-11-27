package server

import (
	"bytes"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSanitizeHTML(t *testing.T) {
	in := `<p onclick="x()">Hi</p><script>alert(1)</script><input type="checkbox" checked><input type="text">` +
		`<a href="javascript:alert(1)">x</a><iframe src="y"></iframe><form><button>b</button></form>`
	out := SanitizeHTML(in)
	for _, bad := range []string{"<script", "onclick", "javascript:", "<iframe", "<form", "<button", `type="text"`} {
		if strings.Contains(out, bad) {
			t.Errorf("sanitized output still contains %q: %s", bad, out)
		}
	}
	if !strings.Contains(out, `<input type="checkbox" data-plan-task="true" checked>`) {
		t.Errorf("task checkbox not preserved: %s", out)
	}
}

// The dashboard is embedded from a copy; `go generate ./...` refreshes it.
func TestEmbeddedDashboardMatchesSource(t *testing.T) {
	src := filepath.Join("..", "..", "..", "src", "dashboard")
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Skip("source dashboard not available")
	}
	for _, e := range entries {
		want, _ := os.ReadFile(filepath.Join(src, e.Name()))
		got, err := dashboardFS.ReadFile("dashboard/" + e.Name())
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("embedded %s is stale; run go generate ./internal/server", e.Name())
		}
	}
}

func TestSortByTouchedNewestFirst(t *testing.T) {
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	mk := func(title, updated string, modified time.Time) *strictPlan {
		p := &strictPlan{modified: modified}
		p.Title, p.Updated, p.Created = title, updated, "2025-01-01T00:00:00.000Z"
		return p
	}
	list := []*strictPlan{
		mk("old", "2026-01-01T00:00:00.000Z", old),
		mk("edited in obsidian", "2026-01-01T00:00:00.000Z", old.Add(72*time.Hour)),
		mk("new", "2026-01-02T00:00:00.000Z", old),
	}
	sortByTouched(list)
	var got []string
	for _, p := range list {
		got = append(got, p.Title)
	}
	if strings.Join(got, ",") != "edited in obsidian,new,old" {
		t.Fatalf("order = %v", got)
	}
}

func TestSanitizeHTMLURLSchemeAllowlist(t *testing.T) {
	bad := []string{
		`<a href="&#1;javascript:alert(1)">b</a>`,
		"<a href=\"\x01javascript:alert(1)\">b</a>",
		`<a href="java&#9;script:alert(1)">b</a>`,
		`<a href="java&#x0A;script:alert(1)">b</a>`,
		`<a href=" JaVaScRiPt:alert(1)">b</a>`,
		`<a href='&#106;avascript:alert(1)'>b</a>`,
		`<a href=javascript:alert(1)>b</a>`,
		`<img src="vbscript:msgbox(1)">`,
		`<img src="data:text/html,<script>alert(1)</script>">`,
		`<a xlink:href="javascript:alert(1)">b</a>`,
		`<img srcset="javascript:alert(1) 1x">`,
	}
	for _, in := range bad {
		out := SanitizeHTML(in)
		low := strings.ToLower(html.UnescapeString(out))
		if strings.Contains(low, "script:") || strings.Contains(low, "data:") || strings.Contains(low, "srcset") {
			t.Errorf("SanitizeHTML(%q) = %q", in, out)
		}
	}
	good := []string{
		`<a href="https://example.com/a?b=c#d">x</a>`,
		`<a href="http://example.com">x</a>`,
		`<a href="mailto:me@example.com">x</a>`,
		`<a href="#section">x</a>`,
		`<a href="/plans/x">x</a>`,
		`<a href="notes/a:b">x</a>`,
		`<img src="image.png" alt="a">`,
	}
	for _, in := range good {
		if out := SanitizeHTML(in); out != in {
			t.Errorf("SanitizeHTML(%q) changed a safe URL: %q", in, out)
		}
	}
	// Text that only looks like an attribute is left alone.
	if in := `<p>use href="javascript:x" carefully</p>`; SanitizeHTML(in) != in {
		t.Errorf("text changed: %q", SanitizeHTML(in))
	}
}

func TestRenderMarkdownBlocksControlCharacterJavascriptLink(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("pandoc unavailable")
	}
	out, err := RenderMarkdown("[b](&#1;javascript:alert(1)) [ok](https://example.com)")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(out), "javascript") || !strings.Contains(out, `href="https://example.com"`) {
		t.Fatalf("rendered = %q", out)
	}
}
