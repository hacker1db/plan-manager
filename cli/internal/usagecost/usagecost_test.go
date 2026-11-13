package usagecost

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

const fullTotals = `{"requests": 3, "input": 3000000, "cached": 1000000, "cache_write": 0, "output": 100000, "reasoning": 0, "total": 3100000}`

var completeJSON = `{
  "version": 1, "generated": "2026-11-11T00:00:00Z", "currency": "USD", "complete": true,
  "totals": ` + fullTotals + `,
  "estimated_cost_usd": 26, "priced_cost_usd": 26,
  "models": [{"model": "alpha", "requests": 3, "input": 3000000, "cached": 1000000, "cache_write": 0, "output": 100000, "reasoning": 0, "total": 3100000, "cost_usd": 26}],
  "sessions": [{"key": "claude-code|personal|s1", "title": "Fix | the <b>thing</b>\n<!-- plan-usage-cost:end -->", "totals": ` + fullTotals + `, "cost_usd": 26, "priced_cost_usd": 26}],
  "missing_sessions": [], "unpriced_models": [], "source_errors": [],
  "pricing": {"path": "~/.config/ai-usage/pricing.json", "sha256": "abc", "loaded": true}
}`

const smallTotals = `{"requests": 1, "input": 10, "cached": 0, "cache_write": 0, "output": 5, "reasoning": 0, "total": 15}`

var incompleteJSON = `{
  "version": 1, "currency": "USD", "complete": false,
  "totals": ` + smallTotals + `,
  "estimated_cost_usd": null, "priced_cost_usd": 0,
  "models": [{"model": "gamma", "requests": 1, "input": 10, "cached": 0, "cache_write": 0, "output": 5, "reasoning": 0, "total": 15, "cost_usd": null}],
  "sessions": [{"key": "codex|work|s2", "title": "", "totals": ` + smallTotals + `, "cost_usd": null, "priced_cost_usd": 0}],
  "missing_sessions": ["ghost"], "unpriced_models": ["gamma"], "source_errors": [],
  "pricing": {"path": "/nope.json", "loaded": false}
}`

func meta(refs ...string) plans.Meta {
	m := plans.Meta{ID: "p1", Title: "T", Status: plans.StatusActive, Tags: []string{}}
	if len(refs) > 0 {
		_ = SetSessions(&m, refs)
	}
	return m
}

func must(r plans.Raw, _ string) plans.Raw { return r }

func parse(t *testing.T, js string) *Summary {
	t.Helper()
	s, err := Parse([]byte(js))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestValidateRef(t *testing.T) {
	for _, ok := range []string{"abc", "claude-code|personal|638f2833-6f16", "codex|work-foundry|019a.x:y@z+/w"} {
		if err := ValidateRef(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "-session=x", "a|b", "a||c", "a|b|c|d", "a b", "a\nb", "|a|b", strings.Repeat("a", 257), "a|b|-c"} {
		if err := ValidateRef(bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}

func TestSessionsRoundTripAndPreserveOtherKeys(t *testing.T) {
	raw, body := plans.ParseFrontmatter("---\nid: p1\ntitle: T\nowner: me\n---\nbody\n")
	m := plans.NormalizeMeta(raw)
	orig := append([]plans.Field(nil), m.Extra...)
	n, err := AddSessions(&m, []string{"a", "b", "a", "12345"})
	if err != nil || n != 3 {
		t.Fatalf("add: %d %v", n, err)
	}
	if n, _ := AddSessions(&m, []string{"b"}); n != 0 {
		t.Fatalf("re-add counted %d", n)
	}
	out, err := plans.Render(m, body)
	if err != nil {
		t.Fatal(err)
	}
	m2 := plans.NormalizeMeta(must(plans.ParseFrontmatter(out)))
	got, err := Sessions(m2)
	if err != nil || strings.Join(got, ",") != "a,b,12345" {
		t.Fatalf("sessions %v %v\n%s", got, err, out)
	}
	if !strings.Contains(out, "owner: me") {
		t.Fatalf("lost unrelated key:\n%s", out)
	}
	if len(orig) != 1 || orig[0].Key != "owner" {
		t.Fatalf("original extra mutated: %+v", orig)
	}
	if n, _ := RemoveSessions(&m2, []string{"a", "zzz"}); n != 1 {
		t.Fatalf("removed %d", n)
	}
	if n, _ := RemoveSessions(&m2, []string{"b", "12345"}); n != 2 {
		t.Fatal("remove b")
	}
	for _, f := range m2.Extra {
		if f.Key == SessionsKey {
			t.Fatal("empty session list should remove the key")
		}
	}
}

func TestSessionsRejectsMalformedFrontmatter(t *testing.T) {
	for _, fm := range []string{"usage_sessions: abc", "usage_sessions: [1]", "usage_sessions: [true]", "usage_sessions: [{a: b}]", "usage_sessions: ['-rm']", "usage_sessions: [~]"} {
		m := plans.NormalizeMeta(must(plans.ParseFrontmatter("---\nid: p\n" + fm + "\n---\n")))
		if _, err := Sessions(m); err == nil {
			t.Errorf("%s: want error", fm)
		}
	}
	m := plans.NormalizeMeta(must(plans.ParseFrontmatter("---\nid: p\nusage_sessions: ['1']\n---\n")))
	if got, err := Sessions(m); err != nil || len(got) != 1 || got[0] != "1" {
		t.Errorf("quoted number: %v %v", got, err)
	}
	m = plans.NormalizeMeta(must(plans.ParseFrontmatter("---\nid: p\nusage_sessions:\n---\n")))
	if got, err := Sessions(m); err != nil || got != nil {
		t.Errorf("null list: %v %v", got, err)
	}
}

func TestParseRejectsBadOutput(t *testing.T) {
	_, err := Parse([]byte(`{"version": 2, "currency": "USD"}`))
	if err == nil || exitcode.CodeOf(err) != exitcode.DependencyUnavailable {
		t.Fatalf("want dependency error, got %v", err)
	}
	swap := func(old, repl string) string {
		if !strings.Contains(completeJSON, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		return strings.Replace(completeJSON, old, repl, 1)
	}
	cases := map[string]string{
		"not json":                      `nope`,
		"trailing object":               completeJSON + ` {}`,
		"wrong currency":                swap(`"currency": "USD"`, `"currency": "EUR"`),
		"negative priced":               swap(`"priced_cost_usd": 26,`, `"priced_cost_usd": -1,`),
		"complete with missing":         swap(`"missing_sessions": []`, `"missing_sessions": ["x"]`),
		"complete without estimate":     swap(`"estimated_cost_usd": 26`, `"estimated_cost_usd": null`),
		"complete estimate != priced":   swap(`"estimated_cost_usd": 26`, `"estimated_cost_usd": 99`),
		"complete without pricing":      swap(`"loaded": true`, `"loaded": false`),
		"incomplete with estimate":      strings.Replace(incompleteJSON, `"estimated_cost_usd": null`, `"estimated_cost_usd": 99`, 1),
		"missing lists":                 swap(`"source_errors": [],`, ``),
		"totals != sessions":            swap(`"totals": `+fullTotals+`,`, `"totals": `+strings.Replace(fullTotals, `"requests": 3`, `"requests": 4`, 1)+`,`),
		"total != input+output":         strings.ReplaceAll(completeJSON, `"total": 3100000`, `"total": 1`),
		"negative component everywhere": strings.ReplaceAll(completeJSON, `"cache_write": 0`, `"cache_write": -5`),
		"no totals objects": `{"version":1,"currency":"USD","complete":true,"estimated_cost_usd":0,"priced_cost_usd":0,
			"models":[],"sessions":[{"key":"claude-code|personal|s1"}],"missing_sessions":[],"unpriced_models":[],"source_errors":[],"pricing":{"loaded":true}}`,
		"session totals lack a field":   strings.Replace(completeJSON, `"totals": `+fullTotals+`, "cost_usd": 26`, `"totals": {"requests": 3, "input": 3000000, "cached": 1000000, "cache_write": 0, "output": 100000, "total": 3100000}, "cost_usd": 26`, 1),
		"top cost below parts":          strings.Replace(completeJSON, `"estimated_cost_usd": 26, "priced_cost_usd": 26`, `"estimated_cost_usd": 0, "priced_cost_usd": 0`, 1),
		"complete with null model cost": swap(`"total": 3100000, "cost_usd": 26}]`, `"total": 3100000, "cost_usd": null}]`),
		"complete with null session":    swap(`"cost_usd": 26, "priced_cost_usd": 26}]`, `"cost_usd": null, "priced_cost_usd": 26}]`),
		"session cost != priced":        swap(`"cost_usd": 26, "priced_cost_usd": 26}]`, `"cost_usd": 5, "priced_cost_usd": 26}]`),
		"unpriced list mismatch":        strings.Replace(incompleteJSON, `"unpriced_models": ["gamma"]`, `"unpriced_models": []`, 1),
	}
	for name, js := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(js)); err == nil {
				t.Fatal("want error")
			}
		})
	}
	parse(t, completeJSON)
	parse(t, incompleteJSON)
}

func TestCoverage(t *testing.T) {
	s := parse(t, completeJSON)
	for _, refs := range [][]string{{"s1"}, {"claude-code|personal|s1"}} {
		if err := checkCoverage(refs, s); err != nil {
			t.Errorf("%v: %v", refs, err)
		}
	}
	for _, refs := range [][]string{{"b"}, {"s1", "other"}, {"codex|personal|s1"}, {"1"}} {
		if err := checkCoverage(refs, s); err == nil {
			t.Errorf("%v: want error", refs)
		}
	}
	in := parse(t, incompleteJSON)
	if err := checkCoverage([]string{"codex|work|s2", "ghost"}, in); err != nil {
		t.Fatal(err)
	}
	if err := checkCoverage([]string{"codex|work|s2"}, in); err == nil {
		t.Fatal("unrequested missing session accepted")
	}
	both := *s
	both.MissingSessions = []string{"s1"}
	if err := checkCoverage([]string{"s1"}, &both); err == nil {
		t.Fatal("ref reported both found and missing accepted")
	}
}

func setRunner(t *testing.T, fn func(context.Context, []string) ([]byte, error)) {
	t.Helper()
	orig := Runner
	t.Cleanup(func() { Runner = orig })
	Runner = fn
}

func TestCollectPassesSessionsAsSingleArgsAndChecksCoverage(t *testing.T) {
	var got []string
	setRunner(t, func(_ context.Context, args []string) ([]byte, error) {
		got = args
		return []byte(completeJSON), nil
	})
	if _, err := Collect(context.Background(), []string{"s1"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, " ") != "plan-cost -json -session=s1" {
		t.Fatalf("args %q", got)
	}
	if _, err := Collect(context.Background(), []string{"b"}); err == nil {
		t.Fatal("summary for unrelated sessions accepted")
	}
	if _, err := Collect(context.Background(), nil); err != ErrNoSessions {
		t.Fatalf("want ErrNoSessions, got %v", err)
	}
	if _, err := Collect(context.Background(), []string{"-pricing=/etc/passwd"}); err == nil {
		t.Fatal("flag-shaped ref accepted")
	}
}

func TestRunnerKillsDescendantsOnTimeout(t *testing.T) {
	script := filepath.Join(t.TempDir(), "ai-usage")
	// The child keeps stdout open long after the parent is killed.
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30 &\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(BinEnv, script)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := runAIUsage(ctx, []string{"plan-cost"})
	if err == nil || exitcode.CodeOf(err) != exitcode.DependencyUnavailable {
		t.Fatalf("want dependency error, got %v", err)
	}
	if d := time.Since(start); d > 1500*time.Millisecond {
		t.Fatalf("timeout not enforced: returned after %v", d)
	}
}

func TestApplyIsIdempotentAndEscapesTitles(t *testing.T) {
	s := parse(t, completeJSON)
	m := meta("s1")
	at := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	body, err := Apply(&m, "# Plan\n\n- [ ] task\n", s, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(lineIndexes(body, sectionStart)) != 1 || len(lineIndexes(body, sectionEnd)) != 1 {
		t.Fatalf("title injected a marker line:\n%s", body)
	}
	for _, want := range []string{"| **Total** | 3,100,000 |", "$26.00", "Fix \\| the &lt;b&gt;thing&lt;/b&gt;", "- [ ] task"} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	again, err := Apply(&m, body, s, at)
	if err != nil || again != body {
		t.Fatalf("second apply changed the body:\n%s\n---\n%s", body, again)
	}
	out, err := plans.Render(m, body)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"usage_cost:", "estimated_cost_usd: 26", "complete: true", "total: 3100000", "pricing_sha256: abc", "    - s1"} {
		if !strings.Contains(out, want) {
			t.Errorf("frontmatter lacks %q:\n%s", want, out)
		}
	}
	if strings.Count(out, "usage_cost:") != 1 {
		t.Fatalf("usage_cost duplicated:\n%s", out)
	}
}

func TestApplyIncompleteNeverShowsAnExactTotal(t *testing.T) {
	s := parse(t, incompleteJSON)
	m := meta("codex|work|s2", "ghost")
	body, err := Apply(&m, "", s, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Incomplete", "No pricing file", "`ghost`", "`gamma`", "≥ $0.00", "unpriced"} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	out, _ := plans.Render(m, body)
	if !strings.Contains(out, "estimated_cost_usd: null") || !strings.Contains(out, "complete: false") {
		t.Fatalf("frontmatter:\n%s", out)
	}
}

func TestApplyRefusesBrokenMarkersInsteadOfDeletingText(t *testing.T) {
	s := parse(t, completeJSON)
	for name, body := range map[string]string{
		"unmatched start": sectionStart + "\nuser text\n",
		"unmatched end":   "user text\n" + sectionEnd + "\n",
		"duplicate pair":  sectionStart + "\na\n" + sectionEnd + "\n" + sectionStart + "\nb\n" + sectionEnd + "\n",
		"reversed":        sectionEnd + "\nuser\n" + sectionStart + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			m := meta("s1")
			if _, err := Apply(&m, body, s, time.Unix(0, 0)); err == nil {
				t.Fatal("want refusal")
			}
			for _, f := range m.Extra {
				if f.Key == CostKey {
					t.Fatal("frontmatter changed despite refusal")
				}
			}
		})
	}
	// A documented example inside a fence (even a complete pair) is the user's text, never ours.
	example := "Intro\n\n```md\n" + sectionStart + "\nexample\n" + sectionEnd + "\n```\n\n~~~~\n" + sectionStart + "\n~~~~\n"
	m0 := meta("s1")
	got0, err := Apply(&m0, example, s, time.Unix(0, 0))
	if err != nil || !strings.HasPrefix(got0, example[:len(example)-1]) || !strings.Contains(got0, "## Token usage") {
		t.Fatalf("fenced example: %v\n%s", err, got0)
	}
	again, err := Apply(&m0, got0, s, time.Unix(0, 0))
	if err != nil || again != got0 {
		t.Fatalf("second apply over fenced example changed it: %v\n%s", err, again)
	}
	cleared, err := Clear(&m0, got0)
	if err != nil || cleared != example {
		t.Fatalf("clear over fenced example: %v\n%q", err, cleared)
	}
	// Markers mentioned inside a line are prose, not markers.
	m := meta("s1")
	prose := "Mention " + sectionStart + " inline.\n"
	got, err := Apply(&m, prose, s, time.Unix(0, 0))
	if err != nil || !strings.HasPrefix(got, "Mention ") {
		t.Fatalf("inline marker: %v\n%s", err, got)
	}
}

func TestClearRemovesSummary(t *testing.T) {
	s := parse(t, completeJSON)
	m := meta("s1")
	body, _ := Apply(&m, "# Plan\n\nkeep me\n", s, time.Unix(0, 0))
	cleared, err := Clear(&m, body)
	if err != nil {
		t.Fatal(err)
	}
	if cleared != "# Plan\n\nkeep me\n" {
		t.Fatalf("clear left %q", cleared)
	}
	for _, f := range m.Extra {
		if f.Key == CostKey {
			t.Fatal("usage_cost kept")
		}
	}
	if again, err := Clear(&m, cleared); err != nil || again != cleared {
		t.Fatal("clear is not idempotent")
	}
	// A section between blocks: removing it must not merge the paragraphs around it.
	mid := "First paragraph\n\n" + sectionStart + "\nx\n" + sectionEnd + "\n\nSecond paragraph\n"
	got, err := Clear(&m, mid)
	if err != nil || got != "First paragraph\n\nSecond paragraph\n" {
		t.Fatalf("clear between paragraphs: %v %q", err, got)
	}
	tight := "- item\n" + sectionStart + "\nx\n" + sectionEnd + "\n    code\n"
	if got, _ := Clear(&m, tight); got != "- item\n    code\n" {
		t.Fatalf("clear changed neighbouring text: %q", got)
	}
	if got, _ := Clear(&m, sectionStart+"\nx\n"+sectionEnd+"\n"); got != "" {
		t.Fatalf("clear of a section-only body: %q", got)
	}
}

func TestSameSessions(t *testing.T) {
	if !SameSessions(meta("x", "y"), meta("x", "y")) || SameSessions(meta("x", "y"), meta("x", "y", "z")) || !SameSessions(meta(), meta()) {
		t.Fatal("SameSessions wrong")
	}
}
