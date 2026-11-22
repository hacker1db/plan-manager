package server

import (
	"strings"
	"testing"
	"time"
)

// A deeply nested prop once overflowed the parser's stack, a fatal error that
// killed `plan serve` on a single page load.
func TestDeeplyNestedMDXPropDoesNotKillServer(t *testing.T) {
	const depth = 1_000_000
	body := "<Flow steps={" + strings.Repeat("(", depth) + "1" + strings.Repeat(")", depth) + "} />\n"
	ts := startServer(t, map[string]string{"deep.mdx": planFile("deep_plan", "", body)})
	status, res := ts.do("GET", "/api/plans/deep_plan", "")
	if status != 200 {
		t.Fatalf("status %d: %.200s", status, res)
	}
	var detail struct {
		HTML *string `json:"html"`
	}
	decode(t, res, &detail)
	if detail.HTML == nil || !strings.Contains(*detail.HTML, "pm-block-error") {
		t.Fatalf("expected an error card, got %.300s", res)
	}
	if status, _ := ts.do("GET", "/_health", ""); status != 200 {
		t.Fatalf("server unhealthy after render: %d", status)
	}
}

func TestOversizedPlanFileIsRejected(t *testing.T) {
	big := planFile("big_plan", "", strings.Repeat("x", 3<<20))
	ts := startServer(t, map[string]string{"big.md": big, "ok.md": planFile("ok_plan", "", "fine\n")})
	status, res := ts.do("GET", "/api/plans", "")
	if status != 200 || !strings.Contains(res, "ok_plan") {
		t.Fatalf("status %d: %.300s", status, res)
	}
	var list struct {
		Malformed []malformed `json:"malformed"`
	}
	decode(t, res, &list)
	if len(list.Malformed) != 1 || list.Malformed[0].File != "big.md" || !strings.Contains(list.Malformed[0].Error, "larger than") {
		t.Fatalf("malformed = %+v", list.Malformed)
	}
	if status, _ := ts.do("GET", "/api/plans/big_plan", ""); status != 404 {
		t.Fatalf("oversized plan detail status %d", status)
	}
}

func TestMDXRenderIsCachedByRevision(t *testing.T) {
	calls := 0
	defer func(f func(string) string) { renderMDX = f }(renderMDX)
	renderMDX = func(body string) string { calls++; return "<p>ok</p>" }
	ts := startServer(t, map[string]string{"v.mdx": planFile("cached_plan", "", "Hello\n")})
	for range 3 {
		if status, res := ts.do("GET", "/api/plans/cached_plan", ""); status != 200 || !strings.Contains(res, `"renderState":"rendered"`) {
			t.Fatalf("status %d: %s", status, res)
		}
	}
	if calls != 1 {
		t.Fatalf("rendered %d times for one revision", calls)
	}
}

func TestSlowMDXRenderTimesOut(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	defer func(f func(string) string, d time.Duration) { renderMDX, mdxRenderTimeout = f, d }(renderMDX, mdxRenderTimeout)
	renderMDX = func(string) string { <-release; return "" }
	mdxRenderTimeout = 50 * time.Millisecond
	ts := startServer(t, map[string]string{"slow.mdx": planFile("slow_plan", "", "Hello\n")})
	status, res := ts.do("GET", "/api/plans/slow_plan", "")
	if status != 200 || !strings.Contains(res, `"renderState":"failed"`) || !strings.Contains(res, `"html":null`) {
		t.Fatalf("status %d: %s", status, res)
	}
}

func TestPanickingMDXRenderDoesNotStopServer(t *testing.T) {
	defer func(f func(string) string) { renderMDX = f }(renderMDX)
	renderMDX = func(string) string { panic("renderer bug") }
	ts := startServer(t, map[string]string{"p.mdx": planFile("panic_plan", "", "Hello\n")})
	if status, res := ts.do("GET", "/api/plans/panic_plan", ""); status != 200 || !strings.Contains(res, "MDX could not be rendered") {
		t.Fatalf("status %d: %s", status, res)
	}
	if status, _ := ts.do("GET", "/_health", ""); status != 200 {
		t.Fatalf("server unhealthy: %d", status)
	}
}
