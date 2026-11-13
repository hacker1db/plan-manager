package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/usagecost"
)

// fakeSummary answers exactly the requested sessions, each 1000 in + 500 out at $0.75.
func fakeSummary(args []string) []byte {
	type m = map[string]any
	tot := func(n int64) m {
		return m{"requests": n, "input": 1000 * n, "cached": 0, "cache_write": 0, "output": 500 * n, "reasoning": 0, "total": 1500 * n}
	}
	sessions := []m{}
	for _, a := range args {
		ref, ok := strings.CutPrefix(a, "-session=")
		if !ok {
			continue
		}
		key := ref
		if !strings.Contains(ref, "|") {
			key = "claude-code|personal|" + ref
		}
		sessions = append(sessions, m{"key": key, "title": "t", "totals": tot(1), "cost_usd": 0.75, "priced_cost_usd": 0.75})
	}
	n := int64(len(sessions))
	cost := 0.75 * float64(n)
	out, _ := json.Marshal(m{
		"version": 1, "currency": "USD", "complete": true, "totals": tot(n), "estimated_cost_usd": cost, "priced_cost_usd": cost,
		"models":   []m{{"model": "alpha", "requests": n, "input": 1000 * n, "cached": 0, "cache_write": 0, "output": 500 * n, "reasoning": 0, "total": 1500 * n, "cost_usd": cost}},
		"sessions": sessions, "missing_sessions": []string{}, "unpriced_models": []string{}, "source_errors": []string{},
		"pricing": m{"path": "p", "sha256": "x", "loaded": true},
	})
	return out
}

func run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := NewRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func newPlan(t *testing.T, title string) string {
	t.Helper()
	out, err := run(t, "create", "--title", title, "--json")
	if err != nil {
		t.Fatal(err)
	}
	var env struct{ ID string }
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatal(err)
	}
	return env.ID
}

// setRunner replaces ai-usage; the hook, when set, runs during collection. Tests using it must
// not call t.Parallel: Runner is package state.
func setRunner(t *testing.T, fail error, hook func()) *int {
	t.Helper()
	calls := 0
	orig := usagecost.Runner
	t.Cleanup(func() { usagecost.Runner = orig })
	usagecost.Runner = func(_ context.Context, args []string) ([]byte, error) {
		calls++
		if hook != nil {
			hook()
		}
		if fail != nil {
			return nil, fail
		}
		return fakeSummary(args), nil
	}
	return &calls
}

func archived(t *testing.T) string {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(os.Getenv("PLAN_HOME"), "archive", "*.md"))
	if len(files) != 1 {
		t.Fatalf("archive holds %d files", len(files))
	}
	data, _ := os.ReadFile(files[0])
	return string(data)
}

func active(t *testing.T, slug string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(os.Getenv("PLAN_HOME"), slug+".md"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestArchiveWithoutSessionsDoesNotRunAIUsage(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	calls := setRunner(t, errors.New("must not run"), nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "archive", "--", id); err != nil {
		t.Fatal(err)
	}
	if *calls != 0 || strings.Contains(archived(t), "usage_cost") {
		t.Fatalf("calls=%d or usage_cost written for a plan with no sessions", *calls)
	}
}

func TestArchiveRecordsUsage(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	calls := setRunner(t, nil, nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "usage", "link", "--", id, "claude-code|personal|s1", "s2"); err != nil {
		t.Fatal(err)
	}
	out, err := run(t, "archive", "--", id)
	if err != nil {
		t.Fatal(err)
	}
	if *calls != 1 || !strings.Contains(out, "est. $1.50") {
		t.Fatalf("calls=%d out=%s", *calls, out)
	}
	doc := archived(t)
	for _, want := range []string{"status: archived", "usage_cost:", "estimated_cost_usd: 1.5", "## Token usage and estimated cost"} {
		if !strings.Contains(doc, want) {
			t.Errorf("archived plan lacks %q:\n%s", want, doc)
		}
	}
	if _, err := run(t, "archive", "--", id); err != nil || *calls != 1 {
		t.Fatalf("re-archive: err=%v calls=%d", err, *calls)
	}
}

func TestArchiveRefusesWhenCollectionFails(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	setRunner(t, exitcode.New(exitcode.DependencyUnavailable, "ai-usage not found"), nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "usage", "link", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	_, err := run(t, "archive", "--", id)
	if exitcode.CodeOf(err) != exitcode.DependencyUnavailable || !strings.Contains(err.Error(), "--skip-cost") {
		t.Fatalf("want dependency error with hint, got %v", err)
	}
	if files, _ := filepath.Glob(filepath.Join(os.Getenv("PLAN_HOME"), "archive", "*.md")); len(files) != 0 {
		t.Fatal("plan archived despite failed collection")
	}
	if _, err := run(t, "status", "--", id, "archived"); exitcode.CodeOf(err) != exitcode.DependencyUnavailable {
		t.Fatalf("status archived bypassed cost: %v", err)
	}
	if _, err := run(t, "archive", "--skip-cost", "--", id); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(archived(t), "usage_cost") {
		t.Fatal("--skip-cost still wrote usage_cost")
	}
}

// status archived records the summary; a later archive only relocates and keeps it, even when
// ai-usage is gone by then.
func TestStatusArchivedThenRelocateKeepsSummary(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	setRunner(t, nil, nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "usage", "link", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "status", "--", id, "archived"); err != nil {
		t.Fatal(err)
	}
	calls := setRunner(t, errors.New("ai-usage removed"), nil)
	if _, err := run(t, "archive", "--", id); err != nil {
		t.Fatalf("relocation needed ai-usage: %v", err)
	}
	if *calls != 0 || !strings.Contains(archived(t), "estimated_cost_usd: 0.75") {
		t.Fatalf("calls=%d; summary lost:\n%s", *calls, archived(t))
	}
}

// A plan reopened inside archive/ is a real transition again and is re-priced.
func TestReopenedPlanInArchiveIsRecollected(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	calls := setRunner(t, nil, nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "archive", "--", id); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "status", "--", id, "active"); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "usage", "link", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "archive", "--", id); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 || !strings.Contains(archived(t), "status: archived") || !strings.Contains(archived(t), "usage_cost:") {
		t.Fatalf("calls=%d:\n%s", *calls, archived(t))
	}
}

// Rebinding the slug to a different plan during collection must never modify the impostor.
func TestArchiveFollowsPlanIDWhenSlugIsRebound(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PLAN_HOME", home)
	id := newPlan(t, "Demo")
	if _, err := run(t, "usage", "link", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	original := active(t, "demo")
	impostor := strings.Replace(original, "id: "+id, "id: impostor0001", 1)
	setRunner(t, nil, func() {
		_ = os.Rename(filepath.Join(home, "demo.md"), filepath.Join(home, "renamed.md"))
		_ = os.WriteFile(filepath.Join(home, "demo.md"), []byte(impostor), 0o600)
	})
	// The command is pinned to the plan's ID, so it follows the original to its new name.
	if _, err := run(t, "archive", "demo"); err != nil {
		t.Fatal(err)
	}
	if active(t, "demo") != impostor {
		t.Fatal("the impostor that took over the slug was modified")
	}
	if doc := archived(t); !strings.Contains(doc, "id: "+id) || !strings.Contains(doc, "usage_cost:") {
		t.Fatalf("original plan not archived with its summary:\n%s", doc)
	}
}

// A snapshot taken when the plan looked archived must not authorize an un-priced archive.
func TestNilSnapshotRefusesApply(t *testing.T) {
	var snap *costSnapshot
	_, err := snap.apply(&plans.Plan{Meta: plans.Meta{ID: "x", Status: plans.StatusActive}}, &plans.Meta{})
	if exitcode.CodeOf(err) != exitcode.Conflict {
		t.Fatalf("want conflict, got %v", err)
	}
}

func TestUnlinkClearsStaleSummary(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	setRunner(t, nil, nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "usage", "link", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := run(t, "usage", "cost", "--save", "--", id); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(active(t, "cost-plan"), "usage_cost:") {
		t.Fatal("cost --save wrote nothing")
	}
	if _, err := run(t, "usage", "unlink", "--", id, "s1"); err != nil {
		t.Fatal(err)
	}
	doc := active(t, "cost-plan")
	if strings.Contains(doc, "usage_cost") || strings.Contains(doc, "Token usage and estimated cost") {
		t.Fatalf("stale summary survived unlink:\n%s", doc)
	}
}

func TestUsageLinkValidatesAndCostRequiresSessions(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	setRunner(t, nil, nil)
	id := newPlan(t, "Cost plan")
	if _, err := run(t, "usage", "link", "--", id, "-evil"); exitcode.CodeOf(err) != exitcode.InvalidInput {
		t.Fatalf("flag-shaped ref accepted: %v", err)
	}
	if _, err := run(t, "usage", "cost", "--", id); exitcode.CodeOf(err) != exitcode.InvalidInput {
		t.Fatalf("cost without sessions: %v", err)
	}
	if _, err := run(t, "usage", "link", "--", id, "a", "b"); err != nil {
		t.Fatal(err)
	}
	out, err := run(t, "usage", "unlink", "--json", "--", id, "a")
	if err != nil || !strings.Contains(out, `"sessions":["b"]`) || !strings.Contains(out, `"changed":1`) {
		t.Fatalf("unlink: %v %s", err, out)
	}
	out, err = run(t, "usage", "cost", "--save", "--json", "--", id)
	if err != nil || !strings.Contains(out, `"saved":true`) || !strings.Contains(out, `claude-code|personal|b`) {
		t.Fatalf("cost --save: %v %s", err, out)
	}
	if doc := active(t, "cost-plan"); !strings.Contains(doc, "usage_cost:") || !strings.Contains(doc, "status: active") {
		t.Fatalf("cost --save did not write the summary:\n%s", doc)
	}
}
