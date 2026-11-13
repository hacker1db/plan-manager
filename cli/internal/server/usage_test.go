package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/usagecost"
)

const totals = `{"requests":1,"input":10,"cached":0,"cache_write":0,"output":5,"reasoning":0,"total":15}`

const fakeSummary = `{"version":1,"currency":"USD","complete":true,
 "totals":` + totals + `,"estimated_cost_usd":0.25,"priced_cost_usd":0.25,
 "models":[{"model":"m","requests":1,"input":10,"cached":0,"cache_write":0,"output":5,"reasoning":0,"total":15,"cost_usd":0.25}],
 "sessions":[{"key":"codex|work|s1","totals":` + totals + `,"cost_usd":0.25,"priced_cost_usd":0.25}],
 "missing_sessions":[],"unpriced_models":[],"source_errors":[],"pricing":{"loaded":true}}`

const planDoc = "---\nid: plan0001\ntitle: T\nstatus: active\ncreated: \"2026-11-11T00:00:00.000Z\"\nupdated: \"2026-11-11T00:00:00.000Z\"\ntags: []\nusage_sessions:\n  - codex|work|s1\n---\nBody\n"

func startServer(t *testing.T, home string) (*Server, string) {
	t.Helper()
	s, err := Start(Options{Port: 0, Host: "127.0.0.1", PlanHome: home, NoWatch: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	base := "http://127.0.0.1:" + strconv.Itoa(s.Port)
	return s, base
}

func post(t *testing.T, s *Server, url, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("X-Csrf-Token", s.csrf)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func setRunner(t *testing.T, out string, err error) {
	orig := usagecost.Runner
	t.Cleanup(func() { usagecost.Runner = orig })
	usagecost.Runner = func(context.Context, []string) ([]byte, error) { return []byte(out), err }
}

func TestArchiveRecordsUsageOrRefuses(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "t.md"), []byte(planDoc), 0o600); err != nil {
		t.Fatal(err)
	}
	s, base := startServer(t, home)
	waitIndexed(t, s, "plan0001")

	setRunner(t, "", errors.New("ai-usage not found"))
	setRunner(t, "", errors.New("STDERR_SENTINEL from ai-usage"))
	code, body := post(t, s, base+"/api/plans/plan0001/archive", "{}")
	if code != 424 || !strings.Contains(body, "skip-cost") || strings.Contains(body, "STDERR_SENTINEL") {
		t.Fatalf("archive with failing ai-usage: %d %s", code, body)
	}
	code, _ = post(t, s, base+"/api/plans/plan0001/status", `{"status":"archived"}`)
	if code != 424 {
		t.Fatalf("status archived bypassed cost recording: %d", code)
	}
	if _, err := os.Stat(filepath.Join(home, "t.md")); err != nil {
		t.Fatal("plan moved despite failed collection")
	}

	setRunner(t, fakeSummary, nil)
	code, body = post(t, s, base+"/api/plans/plan0001/archive", "{}")
	if code != 200 {
		t.Fatalf("archive: %d %s", code, body)
	}
	data, err := os.ReadFile(filepath.Join(home, "archive", "t.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"status: archived", "usage_cost:", "estimated_cost_usd: 0.25", "## Token usage and estimated cost", "Body"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("archived plan lacks %q:\n%s", want, data)
		}
	}
}

// A plan reopened inside archive/ and archived again through the status endpoint is a real
// transition and must be priced, not refused forever.
func TestStatusArchiveOfReopenedPlanInArchiveCollects(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "archive"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "archive", "t.md"), []byte(planDoc), 0o600); err != nil {
		t.Fatal(err)
	}
	s, base := startServer(t, home)
	waitIndexed(t, s, "plan0001")
	setRunner(t, fakeSummary, nil)
	code, body := post(t, s, base+"/api/plans/plan0001/status", `{"status":"archived"}`)
	if code != 200 {
		t.Fatalf("status: %d %s", code, body)
	}
	data, _ := os.ReadFile(filepath.Join(home, "archive", "t.md"))
	if !strings.Contains(string(data), "status: archived") || !strings.Contains(string(data), "usage_cost:") {
		t.Fatalf("not priced:\n%s", data)
	}
	// Already archived: relocation and repeated status changes never re-run collection.
	setRunner(t, "", errors.New("must not run"))
	if code, body := post(t, s, base+"/api/plans/plan0001/archive", "{}"); code != 200 {
		t.Fatalf("archive of archived plan: %d %s", code, body)
	}
}

func TestApplyCostRefusesStaleSnapshot(t *testing.T) {
	p := &strictPlan{}
	p.ID, p.Status = "plan0001", plans.StatusActive
	if _, state, _ := applyCost(p, nil, &plans.Meta{}); state != "changed" {
		t.Fatalf("nil snapshot for an active plan: state %q", state)
	}
	other := &costSnap{linked: plans.Meta{ID: "plan0002"}}
	if _, state, _ := applyCost(p, other, &plans.Meta{}); state != "changed" {
		t.Fatalf("snapshot for another plan: state %q", state)
	}
}

func waitIndexed(t *testing.T, s *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p, _ := s.findPlan(id); p != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("plan %s never indexed", id)
}
