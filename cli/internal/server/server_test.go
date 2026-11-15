package server

import (
	"bytes"
	"os"
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
