// Package usagecost links AI sessions to a plan and records their token usage and estimated cost.
//
// Sessions are linked by hand and stored in the plan's frontmatter under usage_sessions. The
// numbers come from `ai-usage plan-cost -json`, which reads the local tool logs; this package only
// runs it, checks its output, and writes a summary into the plan (frontmatter usage_cost plus a
// managed section at the end of the body). Nothing here estimates usage on its own.
package usagecost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

const (
	// SessionsKey is the frontmatter list of linked session references.
	SessionsKey = "usage_sessions"
	// CostKey is the frontmatter summary written by Record.
	CostKey = "usage_cost"
	// SchemaVersion is the ai-usage plan-cost JSON version this package understands.
	SchemaVersion = 1
	// BinEnv overrides the ai-usage executable.
	BinEnv = "PLAN_AI_USAGE_BIN"

	sectionStart = "<!-- plan-usage-cost:start -->"
	sectionEnd   = "<!-- plan-usage-cost:end -->"

	maxOutput  = 16 << 20
	waitDelay  = 2 * time.Second
	maxRefs    = 200
	maxRefLen  = 256
	runTimeout = 2 * time.Minute
)

// ErrNoSessions means the plan has nothing linked, so there is nothing to record.
var ErrNoSessions = errors.New("no sessions linked")

var refPart = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$`)

// ValidateRef checks one session reference: "tool|profile|id" or a bare id.
func ValidateRef(ref string) error {
	if ref == "" || len(ref) > maxRefLen {
		return fmt.Errorf("session reference must be 1-%d characters", maxRefLen)
	}
	parts := strings.Split(ref, "|")
	if len(parts) != 1 && len(parts) != 3 {
		return fmt.Errorf("session %q: want tool|profile|id or a bare id", ref)
	}
	for _, p := range parts {
		if !refPart.MatchString(p) {
			return fmt.Errorf("session %q: each part must start with a letter or digit and use only letters, digits, and . _ : @ + / -", ref)
		}
	}
	return nil
}

// Sessions returns the plan's linked session references.
func Sessions(m plans.Meta) ([]string, error) {
	n := extra(m, SessionsKey)
	if n == nil || (n.Kind == yaml.ScalarNode && n.Tag == "!!null") {
		return nil, nil
	}
	if n.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("%s must be a list of session references", SessionsKey)
	}
	out := make([]string, 0, len(n.Content))
	for _, item := range n.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			return nil, fmt.Errorf("%s must contain only strings (quote ids that look like numbers)", SessionsKey)
		}
		if err := ValidateRef(item.Value); err != nil {
			return nil, fmt.Errorf("%s: %w", SessionsKey, err)
		}
		out = append(out, item.Value)
	}
	return out, nil
}

// SetSessions replaces the linked sessions; an empty list removes the key.
func SetSessions(m *plans.Meta, refs []string) error {
	if len(refs) > maxRefs {
		return fmt.Errorf("at most %d sessions can be linked to a plan", maxRefs)
	}
	if len(refs) == 0 {
		removeExtra(m, SessionsKey)
		return nil
	}
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, r := range refs {
		if err := ValidateRef(r); err != nil {
			return err
		}
		seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: r})
	}
	setExtra(m, SessionsKey, seq)
	return nil
}

// AddSessions appends refs that are not linked yet and reports how many were new.
func AddSessions(m *plans.Meta, refs []string) (int, error) {
	cur, err := Sessions(*m)
	if err != nil {
		return 0, err
	}
	have := map[string]bool{}
	for _, r := range cur {
		have[r] = true
	}
	added := 0
	for _, r := range refs {
		if err := ValidateRef(r); err != nil {
			return 0, err
		}
		if !have[r] {
			have[r] = true
			cur = append(cur, r)
			added++
		}
	}
	return added, SetSessions(m, cur)
}

// RemoveSessions drops refs and reports how many were removed.
func RemoveSessions(m *plans.Meta, refs []string) (int, error) {
	cur, err := Sessions(*m)
	if err != nil {
		return 0, err
	}
	drop := map[string]bool{}
	for _, r := range refs {
		drop[r] = true
	}
	kept := cur[:0:0]
	for _, r := range cur {
		if !drop[r] {
			kept = append(kept, r)
		}
	}
	return len(cur) - len(kept), SetSessions(m, kept)
}

// Metrics mirrors ai-usage's token counters. Input includes cache reads and writes.
type Metrics struct {
	Requests   int64 `json:"requests" yaml:"requests"`
	Input      int64 `json:"input" yaml:"input"`
	Cached     int64 `json:"cached" yaml:"cached"`
	CacheWrite int64 `json:"cache_write" yaml:"cache_write"`
	Output     int64 `json:"output" yaml:"output"`
	Reasoning  int64 `json:"reasoning" yaml:"reasoning"`
	Total      int64 `json:"total" yaml:"total"`
}

// ModelCost is one model's usage. CostUSD is nil when the model has no price.
type ModelCost struct {
	Model string `json:"model"`
	Metrics
	CostUSD *float64 `json:"cost_usd"`
}

// SessionCost is one linked session.
type SessionCost struct {
	Key           string   `json:"key"`
	Title         string   `json:"title"`
	First         string   `json:"first"`
	Last          string   `json:"last"`
	Totals        Metrics  `json:"totals"`
	CostUSD       *float64 `json:"cost_usd"`
	PricedCostUSD float64  `json:"priced_cost_usd"`
}

// Summary is the subset of `ai-usage plan-cost -json` that plans record.
type Summary struct {
	Version          int           `json:"version"`
	Generated        string        `json:"generated"`
	Currency         string        `json:"currency"`
	Complete         bool          `json:"complete"`
	Totals           Metrics       `json:"totals"`
	EstimatedCostUSD *float64      `json:"estimated_cost_usd"`
	PricedCostUSD    float64       `json:"priced_cost_usd"`
	Models           []ModelCost   `json:"models"`
	Sessions         []SessionCost `json:"sessions"`
	MissingSessions  []string      `json:"missing_sessions"`
	UnpricedModels   []string      `json:"unpriced_models"`
	SourceErrors     []string      `json:"source_errors"`
	Pricing          struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
		Loaded bool   `json:"loaded"`
	} `json:"pricing"`
}

// Runner runs ai-usage with args and returns its stdout. Tests replace it.
var Runner = runAIUsage

func runAIUsage(ctx context.Context, args []string) ([]byte, error) {
	bin := os.Getenv(BinEnv)
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("ai-usage"); err != nil {
			return nil, exitcode.New(exitcode.DependencyUnavailable,
				"ai-usage not found on PATH (set %s to its path, or archive with --skip-cost)", BinEnv)
		}
	}
	c := exec.CommandContext(ctx, bin, args...)
	// Own process group, killed whole on cancel, and a bounded wait for inherited pipes: a child
	// that forks and keeps stdout open can't hold the caller past the timeout.
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
	c.WaitDelay = waitDelay
	stdout := &capped{limit: maxOutput}
	stderr := &capped{limit: 64 << 10}
	c.Stdout, c.Stderr = stdout, stderr
	err := c.Run()
	if stdout.over {
		return nil, fmt.Errorf("ai-usage output exceeded %d bytes", maxOutput)
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.buf.String())
		if msg == "" {
			msg = err.Error()
		}
		if ctx.Err() != nil {
			msg = "timed out after " + runTimeout.String()
		}
		return nil, exitcode.New(exitcode.DependencyUnavailable, "ai-usage plan-cost failed: %s", msg)
	}
	return stdout.buf.Bytes(), nil
}

// capped keeps at most limit bytes and then fails the write, which stops the child's output.
type capped struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.limit - c.buf.Len(); len(p) > room {
		c.over = true
		c.buf.Write(p[:max(room, 0)])
		return 0, io.ErrShortWrite
	}
	return c.buf.Write(p)
}

// Collect runs ai-usage for refs and validates the result against the request.
func Collect(ctx context.Context, refs []string) (*Summary, error) {
	if len(refs) == 0 {
		return nil, ErrNoSessions
	}
	args := []string{"plan-cost", "-json"}
	for _, r := range refs {
		if err := ValidateRef(r); err != nil {
			return nil, err
		}
		// -session=value form: a value can never be parsed as another flag.
		args = append(args, "-session="+r)
	}
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	out, err := Runner(ctx, args)
	if err != nil {
		return nil, err
	}
	s, err := Parse(out)
	if err != nil {
		return nil, err
	}
	if err := checkCoverage(refs, s); err != nil {
		return nil, fmt.Errorf("ai-usage plan-cost: %w", err)
	}
	return s, nil
}

// Parse decodes and checks `ai-usage plan-cost -json` output. Anything inconsistent is rejected
// before it can be written into a plan.
func Parse(data []byte) (*Summary, error) {
	var s Summary
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("ai-usage plan-cost: invalid JSON: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("ai-usage plan-cost: trailing data after the JSON object")
	}
	if s.Version != SchemaVersion {
		return nil, exitcode.New(exitcode.DependencyUnavailable,
			"ai-usage plan-cost schema version %d is not supported (want %d); upgrade plan or ai-usage", s.Version, SchemaVersion)
	}
	if err := requireFields(data); err != nil {
		return nil, fmt.Errorf("ai-usage plan-cost: %w", err)
	}
	if err := s.check(); err != nil {
		return nil, fmt.Errorf("ai-usage plan-cost: %w", err)
	}
	return &s, nil
}

func (s *Summary) check() error {
	if s.Currency != "USD" {
		return fmt.Errorf("unexpected currency %q", s.Currency)
	}
	if s.Models == nil || s.Sessions == nil || s.MissingSessions == nil || s.UnpricedModels == nil || s.SourceErrors == nil {
		return errors.New("models, sessions, missing_sessions, unpriced_models, and source_errors are required")
	}
	if !s.Totals.valid() || !nonNegative(s.PricedCostUSD) || (s.EstimatedCostUSD != nil && !nonNegative(*s.EstimatedCostUSD)) {
		return errors.New("negative or invalid totals")
	}
	var bySession, byModel Metrics
	for _, sc := range s.Sessions {
		if sc.Key == "" || !sc.Totals.valid() || !nonNegative(sc.PricedCostUSD) || (sc.CostUSD != nil && !nonNegative(*sc.CostUSD)) {
			return fmt.Errorf("session %q: missing key or invalid totals", sc.Key)
		}
		bySession.add(sc.Totals)
	}
	for _, m := range s.Models {
		if m.Model == "" || !m.Metrics.valid() || (m.CostUSD != nil && !nonNegative(*m.CostUSD)) {
			return fmt.Errorf("model %q: missing name or invalid totals", m.Model)
		}
		byModel.add(m.Metrics)
	}
	if bySession != s.Totals || byModel != s.Totals {
		return errors.New("totals do not equal the sum of sessions and of models")
	}
	// Money must reconcile too. Each figure is rounded to a micro-dollar, so allow that per item.
	tol := 1e-6 * float64(len(s.Sessions)+len(s.Models)+1)
	var sessionPriced, modelPriced float64
	unpricedModels := map[string]bool{}
	for _, sc := range s.Sessions {
		sessionPriced += sc.PricedCostUSD
		if sc.CostUSD != nil && math.Abs(*sc.CostUSD-sc.PricedCostUSD) > tol {
			return fmt.Errorf("session %q: cost and priced cost differ", sc.Key)
		}
		if s.Complete && sc.CostUSD == nil {
			return fmt.Errorf("complete summary has an unpriced session %q", sc.Key)
		}
	}
	for _, m := range s.Models {
		if m.CostUSD == nil {
			unpricedModels[m.Model] = true
		} else {
			modelPriced += *m.CostUSD
		}
	}
	if math.Abs(sessionPriced-s.PricedCostUSD) > tol || math.Abs(modelPriced-s.PricedCostUSD) > tol {
		return errors.New("priced cost does not equal the sum of sessions and of models")
	}
	if len(unpricedModels) != len(s.UnpricedModels) {
		return errors.New("unpriced_models does not match the models without a cost")
	}
	for _, name := range s.UnpricedModels {
		if !unpricedModels[name] {
			return fmt.Errorf("unpriced model %q has a cost or is not listed", name)
		}
	}
	gaps := len(s.MissingSessions) > 0 || len(s.UnpricedModels) > 0 || len(s.SourceErrors) > 0 || !s.Pricing.Loaded || len(s.Sessions) == 0
	switch {
	case s.Complete && gaps:
		return errors.New("complete summary reports missing sessions, unpriced models, source errors, or no pricing")
	case s.Complete && s.EstimatedCostUSD == nil:
		return errors.New("complete summary has no estimated cost")
	case !s.Complete && s.EstimatedCostUSD != nil:
		return errors.New("incomplete summary carries an estimated cost")
	case s.Complete && math.Abs(*s.EstimatedCostUSD-s.PricedCostUSD) > 1e-6:
		return errors.New("estimated and priced cost differ in a complete summary")
	}
	return nil
}

// checkCoverage requires every requested ref to be reported as found or missing, and every
// returned session to answer some ref, so a summary can never describe unrelated sessions.
func checkCoverage(refs []string, s *Summary) error {
	missing := map[string]bool{}
	for _, m := range s.MissingSessions {
		missing[m] = true
	}
	answered := map[string]bool{}
	for _, ref := range refs {
		matched := 0
		for _, sc := range s.Sessions {
			if sc.Key == ref || (!strings.Contains(ref, "|") && strings.HasSuffix(sc.Key, "|"+ref) && strings.Count(sc.Key, "|") == 2) {
				answered[sc.Key] = true
				matched++
			}
		}
		if matched == 0 && !missing[ref] {
			return fmt.Errorf("session %q is neither reported nor listed as missing", ref)
		}
		if matched > 0 && missing[ref] {
			return fmt.Errorf("session %q is reported both found and missing", ref)
		}
		if matched > 1 {
			return fmt.Errorf("session %q matched %d sessions", ref, matched)
		}
	}
	for _, sc := range s.Sessions {
		if !answered[sc.Key] {
			return fmt.Errorf("returned session %q was not requested", sc.Key)
		}
	}
	for m := range missing {
		found := false
		for _, ref := range refs {
			found = found || ref == m
		}
		if !found {
			return fmt.Errorf("missing session %q was not requested", m)
		}
	}
	return nil
}

// valid checks what ai-usage guarantees: no negative counter and Total = Input + Output. Cache
// counts above input can come from odd tool logs, so they are not rejected here.
var metricKeys = []string{"requests", "input", "cached", "cache_write", "output", "reasoning", "total"}

// requireFields checks that every field the summary is built from is present, so a zero value
// left by a missing field can never pass for a measured zero.
func requireFields(data []byte) error {
	type obj = map[string]json.RawMessage
	var top struct {
		obj
		Totals   obj   `json:"totals"`
		Sessions []obj `json:"sessions"`
		Models   []obj `json:"models"`
		Pricing  obj   `json:"pricing"`
	}
	if err := json.Unmarshal(data, &top.obj); err != nil {
		return err
	}
	if err := json.Unmarshal(data, &top); err != nil {
		return err
	}
	has := func(o obj, where string, keys ...string) error {
		if o == nil {
			return fmt.Errorf("%s is missing", where)
		}
		for _, k := range keys {
			if _, ok := o[k]; !ok {
				return fmt.Errorf("%s lacks %q", where, k)
			}
		}
		return nil
	}
	if err := has(top.obj, "summary", "version", "currency", "complete", "totals", "estimated_cost_usd", "priced_cost_usd",
		"models", "sessions", "missing_sessions", "unpriced_models", "source_errors", "pricing"); err != nil {
		return err
	}
	if err := has(top.Totals, "totals", metricKeys...); err != nil {
		return err
	}
	if err := has(top.Pricing, "pricing", "loaded"); err != nil {
		return err
	}
	for i, sc := range top.Sessions {
		where := fmt.Sprintf("sessions[%d]", i)
		if err := has(sc, where, "key", "totals", "cost_usd", "priced_cost_usd"); err != nil {
			return err
		}
		var tot obj
		if err := json.Unmarshal(sc["totals"], &tot); err != nil {
			return fmt.Errorf("%s.totals: %w", where, err)
		}
		if err := has(tot, where+".totals", metricKeys...); err != nil {
			return err
		}
	}
	for i, m := range top.Models {
		if err := has(m, fmt.Sprintf("models[%d]", i), append([]string{"model", "cost_usd"}, metricKeys...)...); err != nil {
			return err
		}
	}
	return nil
}

func (m Metrics) valid() bool {
	return m.Requests >= 0 && m.Input >= 0 && m.Cached >= 0 && m.CacheWrite >= 0 && m.Output >= 0 &&
		m.Reasoning >= 0 && m.Total == m.Input+m.Output
}

func (m *Metrics) add(o Metrics) {
	m.Requests += o.Requests
	m.Input += o.Input
	m.Cached += o.Cached
	m.CacheWrite += o.CacheWrite
	m.Output += o.Output
	m.Reasoning += o.Reasoning
	m.Total += o.Total
}

func nonNegative(v float64) bool { return v >= 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }

// costRecord is the usage_cost frontmatter. Field order is the on-disk order.
type costRecord struct {
	Recorded         string   `yaml:"recorded"`
	Complete         bool     `yaml:"complete"`
	Currency         string   `yaml:"currency"`
	EstimatedCostUSD *float64 `yaml:"estimated_cost_usd"`
	PricedCostUSD    float64  `yaml:"priced_cost_usd"`
	Sessions         []string `yaml:"sessions"` // the linked references this summary was collected for
	Tokens           Metrics  `yaml:"tokens"`
	MissingSessions  []string `yaml:"missing_sessions"`
	UnpricedModels   []string `yaml:"unpriced_models"`
	SourceErrors     []string `yaml:"source_errors"`
	PricingSHA256    string   `yaml:"pricing_sha256,omitempty"`
}

// Apply writes s into meta (usage_cost) and returns body with the managed section replaced or
// appended. It does not touch the file, and refuses a body whose markers are not one clean pair.
func Apply(meta *plans.Meta, body string, s *Summary, recorded time.Time) (string, error) {
	refs, err := Sessions(*meta)
	if err != nil {
		return "", err
	}
	newBody, err := replaceSection(body, renderSection(s, recorded))
	if err != nil {
		return "", err
	}
	rec := costRecord{
		Recorded: recorded.UTC().Format("2006-01-02T15:04:05.000Z"), Complete: s.Complete, Currency: s.Currency,
		EstimatedCostUSD: s.EstimatedCostUSD, PricedCostUSD: s.PricedCostUSD, Sessions: nonNil(refs),
		Tokens: s.Totals, MissingSessions: nonNil(s.MissingSessions), UnpricedModels: nonNil(s.UnpricedModels),
		SourceErrors: nonNil(s.SourceErrors), PricingSHA256: s.Pricing.SHA256,
	}
	var n yaml.Node
	if err := n.Encode(rec); err != nil {
		return "", err
	}
	setExtra(meta, CostKey, &n)
	return newBody, nil
}

// Clear removes a saved summary (frontmatter and managed section), for when the linked sessions
// change and the old figures no longer describe the plan.
func Clear(meta *plans.Meta, body string) (string, error) {
	newBody, err := replaceSection(body, "")
	if err != nil {
		return "", err
	}
	removeExtra(meta, CostKey)
	return newBody, nil
}

// SameSessions reports whether two metas link the same sessions in the same order, so a summary
// collected outside the write lock can be applied to a re-read plan.
func SameSessions(a, b plans.Meta) bool {
	x, errA := Sessions(a)
	y, errB := Sessions(b)
	if errA != nil || errB != nil || len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func renderSection(s *Summary, recorded time.Time) string {
	var b strings.Builder
	b.WriteString(sectionStart + "\n## Token usage and estimated cost\n\n")
	fmt.Fprintf(&b, "Recorded %s from %d linked session(s) by `ai-usage plan-cost`. Costs are estimates from local logs and a local price table, not billed amounts.\n\n",
		recorded.UTC().Format("2006-01-02 15:04 UTC"), len(s.Sessions))
	if !s.Complete {
		b.WriteString("**Incomplete: the figures below are a lower bound.**\n\n")
		if !s.Pricing.Loaded {
			b.WriteString("- No pricing file was found, so no model was priced.\n")
		}
		for _, l := range []struct {
			label string
			v     []string
		}{{"Missing sessions", s.MissingSessions}, {"Unpriced models", s.UnpricedModels}, {"Source errors", s.SourceErrors}} {
			if len(l.v) > 0 {
				quoted := make([]string, len(l.v))
				for i, v := range l.v {
					quoted[i] = code(v)
				}
				fmt.Fprintf(&b, "- %s: %s\n", l.label, strings.Join(quoted, ", "))
			}
		}
		if len(s.Sessions) == 0 && len(s.MissingSessions) == 0 {
			b.WriteString("- No linked session had usage.\n")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "| | Tokens | Uncached | Output | Requests | Est. cost (USD) |\n|---|---:|---:|---:|---:|---:|\n")
	fmt.Fprintf(&b, "| **Total** | %s | %s | %s | %s | %s |\n", num(s.Totals.Total), num(uncached(s.Totals)),
		num(s.Totals.Output), num(s.Totals.Requests), money(s.EstimatedCostUSD, s.PricedCostUSD))
	for _, m := range s.Models {
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %s |\n", code(m.Model), num(m.Total), num(uncached(m.Metrics)),
			num(m.Output), num(m.Requests), money(m.CostUSD, -1))
	}
	if len(s.Sessions) > 0 {
		b.WriteString("\n| Session | Title | Tokens | Est. cost (USD) |\n|---|---|---:|---:|\n")
		for _, sc := range s.Sessions {
			fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", code(sc.Key), cell(sc.Title), num(sc.Totals.Total),
				money(sc.CostUSD, sc.PricedCostUSD))
		}
	}
	b.WriteString(sectionEnd + "\n")
	return b.String()
}

// replaceSection swaps the managed section for section (or removes it when section is ""), or
// appends section when there is none. Only markers alone on a line count. Anything other than
// zero markers or exactly one start followed by one end is refused, so a stray or duplicated
// marker can never make a save delete user text.
func replaceSection(body, section string) (string, error) {
	starts, ends := lineIndexes(body, sectionStart), lineIndexes(body, sectionEnd)
	switch {
	case len(starts) == 0 && len(ends) == 0:
		if section == "" {
			return body, nil
		}
		trimmed := strings.TrimRight(body, "\n")
		if trimmed == "" {
			return section, nil
		}
		return trimmed + "\n\n" + section, nil
	case len(starts) == 1 && len(ends) == 1 && starts[0] < ends[0]:
		stop := ends[0] + len(sectionEnd)
		if stop < len(body) && body[stop] == '\r' {
			stop++
		}
		if stop < len(body) && body[stop] == '\n' {
			stop++
		}
		before, after := body[:starts[0]], body[stop:]
		if section != "" {
			return before + section + after, nil
		}
		// Removing: keep the text on both sides exactly, dropping only the one blank line that
		// Apply put in front of an appended section, so neighbouring blocks never merge.
		if strings.TrimSpace(after) == "" {
			before = strings.TrimRight(before, "\n")
			if before == "" {
				return "", nil
			}
			return before + "\n", nil
		}
		if strings.HasSuffix(before, "\n\n") && strings.HasPrefix(after, "\n") {
			after = after[1:]
		}
		return before + after, nil
	default:
		return "", exitcode.New(exitcode.InvalidInput,
			"plan body has %d %q and %d %q lines; the usage section needs exactly one of each, in order. Fix the body by hand",
			len(starts), sectionStart, len(ends), sectionEnd)
	}
}

// lineIndexes returns the offset of every line that is exactly marker (a trailing \r allowed),
// skipping fenced code blocks so a documented example is never mistaken for the managed section.
func lineIndexes(s, marker string) []int {
	var out []int
	fence := "" // the opening fence run while inside a fenced block
	for i := 0; i <= len(s); {
		j := strings.IndexByte(s[i:], '\n')
		end := len(s)
		if j >= 0 {
			end = i + j
		}
		line := strings.TrimSuffix(s[i:end], "\r")
		if run := fenceRun(line); run != "" {
			switch {
			case fence == "":
				fence = run
			case run[0] == fence[0] && len(run) >= len(fence) && strings.TrimSpace(strings.TrimLeft(line, " "))[len(run):] == "":
				fence = ""
			}
		} else if fence == "" && line == marker {
			out = append(out, i)
		}
		if j < 0 {
			break
		}
		i = end + 1
	}
	return out
}

// fenceRun returns the ``` or ~~~ run that opens or closes a CommonMark fenced block, or "".
func fenceRun(line string) string {
	trimmed := strings.TrimLeft(line, " ")
	if len(line)-len(trimmed) > 3 || len(trimmed) < 3 || (trimmed[0] != '`' && trimmed[0] != '~') {
		return ""
	}
	n := 0
	for n < len(trimmed) && trimmed[n] == trimmed[0] {
		n++
	}
	if n < 3 {
		return ""
	}
	return trimmed[:n]
}

func uncached(m Metrics) int64 { return max(m.Input-m.Cached, 0) + m.Output }

func num(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var out []byte
	for i := range len(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	if neg {
		return "-" + string(out)
	}
	return string(out)
}

// money shows a full estimate, a lower bound (priced >= 0), or "unpriced".
func money(full *float64, priced float64) string {
	switch {
	case full != nil:
		return fmt.Sprintf("$%.2f", *full)
	case priced > 0:
		return fmt.Sprintf("≥ $%.2f", priced)
	case priced == 0:
		return "≥ $0.00"
	default:
		return "unpriced"
	}
}

// cell makes untrusted text safe inside a Markdown table cell: one line, no pipes, no HTML.
func cell(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	r := strings.NewReplacer("\\", "\\\\", "|", "\\|", "<", "&lt;", ">", "&gt;", "`", "\\`", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]")
	s = r.Replace(s)
	if r := []rune(s); len(r) > 120 {
		s = string(r[:117]) + "…"
	}
	if s == "" {
		return "—"
	}
	return s
}

// code wraps an identifier in a code span, escaping what a span cannot hold.
func code(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	s = strings.NewReplacer("`", "'", "|", "\\|").Replace(s)
	return "`" + s + "`"
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func extra(m plans.Meta, key string) *yaml.Node {
	for _, f := range m.Extra {
		if f.Key == key {
			return f.Value
		}
	}
	return nil
}

// setExtra replaces or appends key without writing into the caller's original slice, so a Meta
// copied from a Plan never changes the Plan.
func setExtra(m *plans.Meta, key string, v *yaml.Node) {
	out := make([]plans.Field, 0, len(m.Extra)+1)
	found := false
	for _, f := range m.Extra {
		if f.Key == key {
			f.Value, found = v, true
		}
		out = append(out, f)
	}
	if !found {
		out = append(out, plans.Field{Key: key, Value: v})
	}
	m.Extra = out
}

func removeExtra(m *plans.Meta, key string) {
	out := m.Extra[:0:0]
	for _, f := range m.Extra {
		if f.Key != key {
			out = append(out, f)
		}
	}
	m.Extra = out
}
