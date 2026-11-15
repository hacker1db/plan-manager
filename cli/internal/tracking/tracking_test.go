package tracking

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

const prID = "00000000-0000-4000-8000-0000000000aa"

func pr(mut func(*ProjectedPR)) *ProjectedPR {
	p := &ProjectedPR{
		PR: PR{Host: "github.com", Owner: "o", Repo: "r", Number: 1, URL: "https://github.com/o/r/pull/1"},
		ID: prID, Role: "implements", Reviews: map[string]Review{},
		Observed: &Observation{State: "merged", HeadSha: "abc1234"},
		Review:   &PrReview{State: "approved", HeadSha: "abc1234"},
	}
	if mut != nil {
		mut(p)
	}
	return p
}

type proj struct {
	approval string
	stale    bool
	prs      []*ProjectedPR
}

func projection(stage string, o proj) *Projection {
	if o.approval == "" {
		o.approval = "approved"
	}
	return &Projection{Stage: stage, PRs: o.prs, PlanApproval: Approval{State: o.approval, BodyRevision: "x", Stale: o.stale}}
}

func wantTrackingError(t *testing.T, err error, substr, label string) {
	t.Helper()
	var te *Error
	if !errors.As(err, &te) || te.Code != "ETRACKING" || !strings.Contains(te.Msg, substr) {
		t.Errorf("%s: got %v, want ETRACKING containing %q", label, err, substr)
	}
}

// Expected result of plan stage <target> from each stage, with a current
// approval and an open PR attached.
var matrix = map[string]map[string]string{
	"planning":             {"planning": "noop", "awaiting_plan_review": "ok", "in_progress": "ok", "awaiting_pr_review": "deny", "completed": "deny"},
	"awaiting_plan_review": {"planning": "ok", "awaiting_plan_review": "noop", "in_progress": "ok", "awaiting_pr_review": "deny", "completed": "deny"},
	"in_progress":          {"planning": "ok", "awaiting_plan_review": "deny", "in_progress": "noop", "awaiting_pr_review": "ok", "completed": "deny"},
	"awaiting_pr_review":   {"planning": "ok", "awaiting_plan_review": "deny", "in_progress": "ok", "awaiting_pr_review": "noop", "completed": "deny"},
	"completed":            {"planning": "deny", "awaiting_plan_review": "deny", "in_progress": "deny", "awaiting_pr_review": "deny", "completed": "deny"},
}

func TestStageTransitionMatrix(t *testing.T) {
	open := []*ProjectedPR{pr(func(p *ProjectedPR) { p.Observed.State = "open" })}
	for _, from := range PlanStages {
		for _, to := range PlanStages {
			changed, err := AssertStageTransition(projection(from, proj{prs: open}), to)
			switch matrix[from][to] {
			case "deny":
				wantTrackingError(t, err, "", from+" -> "+to)
			case "ok":
				if err != nil || !changed {
					t.Errorf("%s -> %s: changed=%v err=%v", from, to, changed, err)
				}
			case "noop":
				if err != nil || changed {
					t.Errorf("%s -> %s: changed=%v err=%v", from, to, changed, err)
				}
			}
		}
	}
}

func TestStageGuards(t *testing.T) {
	for _, o := range []proj{{approval: "none"}, {approval: "pending"}, {approval: "changes_requested"}, {stale: true}} {
		_, err := AssertStageTransition(projection("awaiting_plan_review", o), "in_progress")
		wantTrackingError(t, err, "approv", "start work without current approval")
	}
	draft := pr(func(p *ProjectedPR) { p.Observed.State = "draft" })
	_, err := AssertStageTransition(projection("in_progress", proj{prs: []*ProjectedPR{draft}}), "awaiting_pr_review")
	wantTrackingError(t, err, "draft", "draft PR")
	_, err = AssertStageTransition(projection("in_progress", proj{}), "awaiting_pr_review")
	wantTrackingError(t, err, "open for review", "no PR")
	if changed, err := AssertStageTransition(projection("awaiting_plan_review", proj{approval: "pending", stale: true}), "awaiting_plan_review"); !changed || err != nil {
		t.Errorf("resubmitting a changed body: changed=%v err=%v", changed, err)
	}
}

func TestPlanReviewNeedsSubmittedUnchangedBody(t *testing.T) {
	if err := AssertPlanReview(projection("awaiting_plan_review", proj{approval: "pending"})); err != nil {
		t.Error(err)
	}
	wantTrackingError(t, AssertPlanReview(projection("planning", proj{})), "awaiting_plan_review", "not submitted")
	wantTrackingError(t, AssertPlanReview(projection("awaiting_plan_review", proj{approval: "pending", stale: true})), "changed since", "stale")
}

func source(status string, a *Appended) Source {
	v := SchemaVersion
	if a == nil {
		return Source{ID: "plan-1", Status: status}
	}
	return Source{ID: "plan-1", Status: a.Status, SchemaVersion: &v, Raw: a.Tracking.YAML()}
}

func appendOK(t *testing.T, src Source, eventType string, data *ordered.Obj) *Appended {
	t.Helper()
	a, err := Append(src, EventInput{Type: eventType, Data: data, Actor: "t"}, time.Now())
	if err != nil {
		t.Fatalf("append %s: %v", eventType, err)
	}
	return a
}

func projected(t *testing.T, a *Appended, body *string) *Projection {
	t.Helper()
	p, err := Project(source("", a), body)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPlanApprovalIsKeyedToBodyRevision(t *testing.T) {
	body := "# Plan\n- [ ] step\n"
	rev := BodyRevision(body)
	a := appendOK(t, source("active", nil), "stage", ordered.New().Set("stage", "awaiting_plan_review").Set("bodyRevision", rev))
	if got := projected(t, a, &body).PlanApproval; got != (Approval{State: "pending", BodyRevision: rev}) {
		t.Errorf("pending approval = %+v", got)
	}
	a = appendOK(t, source("", a), "plan.review", ordered.New().Set("decision", "approved").Set("bodyRevision", rev))
	if projected(t, a, &body).PlanApproval.State != "approved" {
		t.Error("approval not recorded")
	}
	spaced := "\n" + body
	if projected(t, a, &spaced).PlanApproval.Stale {
		t.Error("frontmatter spacing is not a revision")
	}
	changed := body + "more"
	if !projected(t, a, &changed).PlanApproval.Stale {
		t.Error("editing the body must make the approval stale")
	}
	rejected := appendOK(t, source("", a), "plan.review", ordered.New().Set("decision", "changes_requested").Set("bodyRevision", rev))
	if projected(t, rejected, &body).Stage != "planning" {
		t.Error("changes requested must return to planning")
	}
	_, err := Append(source("", a), EventInput{Type: "plan.review", Data: ordered.New().Set("decision", "approved").Set("bodyRevision", "abc"), Actor: "t"}, time.Now())
	wantTrackingError(t, err, "sha256", "short body revision")
}

func TestPrReviewsAreKeyedToHeadSha(t *testing.T) {
	parsed, _ := ParsePrURL("https://github.com/o/r/pull/1")
	a := appendOK(t, source("active", nil), "pr.attached", ordered.New().Set("pr", PrObj(prID, parsed, "implements")))
	a = appendOK(t, source("", a), "pr.observed", ordered.New().Set("prId", prID).Set("state", "open").Set("headSha", "abc1234"))
	a = appendOK(t, source("", a), "pr.review", ordered.New().Set("prId", prID).Set("state", "approved").Set("headSha", "abc1234"))
	p := projected(t, a, nil)
	if p.PRs[0].Review.Stale || p.PlanApproval.State != "none" {
		t.Errorf("review=%+v approval=%+v", p.PRs[0].Review, p.PlanApproval)
	}
	a = appendOK(t, source("", a), "pr.observed", ordered.New().Set("prId", prID).Set("state", "open").Set("headSha", "def5678"))
	if r := projected(t, a, nil).PRs[0].Review; r.HeadSha != "abc1234" || !r.Stale {
		t.Errorf("after push: %+v", r)
	}
	a = appendOK(t, source("", a), "pr.review", ordered.New().Set("prId", prID).Set("state", "changes_requested").Set("headSha", "def5678"))
	if r := projected(t, a, nil).PRs[0].Review; r.State != "changes_requested" || r.Stale {
		t.Errorf("new head review: %+v", r)
	}
	_, err := Append(source("", a), EventInput{Type: "pr.review", Data: ordered.New().Set("prId", prID).Set("state", "lgtm").Set("headSha", "def5678"), Actor: "t"}, time.Now())
	wantTrackingError(t, err, "data.state", "bad review state")
	_, err = Append(source("", a), EventInput{Type: "pr.review", Data: ordered.New().Set("prId", prID).Set("state", "approved"), Actor: "t"}, time.Now())
	wantTrackingError(t, err, "headSha", "missing head")
}

func TestCompletionGuards(t *testing.T) {
	if ids, err := AssertCompletion(projection("in_progress", proj{prs: []*ProjectedPR{pr(nil)}}), ""); err != nil || !slices.Equal(ids, []string{prID}) {
		t.Errorf("merged approved PR: %v %v", ids, err)
	}
	if ids, err := AssertCompletion(projection("awaiting_pr_review", proj{}), "docs only"); err != nil || len(ids) != 0 {
		t.Errorf("no-PR rationale: %v %v", ids, err)
	}
	observed := func(state string) func(*ProjectedPR) { return func(p *ProjectedPR) { p.Observed.State = state } }
	denied := []struct {
		p         *Projection
		rationale string
		want      string
	}{
		{projection("planning", proj{prs: []*ProjectedPR{pr(nil)}}), "", "Cannot complete"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(nil)}, stale: true}), "", "approval"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(nil)}, approval: "pending"}), "", "approved plan review"},
		{projection("in_progress", proj{}), "", "no-pr-rationale"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(nil)}}), "docs only", "only for plans without"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(func(p *ProjectedPR) { p.Role = "partial" })}}), "", "Only partial"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(observed("draft"))}}), "", "draft, not merged"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(observed("closed"))}}), "", "closed, not merged"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(func(p *ProjectedPR) { p.Observed = nil })}}), "", "not observed"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(func(p *ProjectedPR) { p.Review = nil })}}), "", "approved review"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(func(p *ProjectedPR) { p.Review = &PrReview{State: "approved", HeadSha: "old0000", Stale: true} })}}), "", "approved review"},
		{projection("in_progress", proj{prs: []*ProjectedPR{pr(func(p *ProjectedPR) { p.Review.State = "dismissed" })}}), "", "approved review"},
	}
	for i, d := range denied {
		_, err := AssertCompletion(d.p, d.rationale)
		wantTrackingError(t, err, d.want, "denied case "+string(rune('a'+i)))
	}
}

func TestReopen(t *testing.T) {
	if err := AssertReopen(projection("completed", proj{approval: "none"}), "planning"); err != nil {
		t.Error(err)
	}
	if err := AssertReopen(projection("completed", proj{}), "in_progress"); err != nil {
		t.Error(err)
	}
	wantTrackingError(t, AssertReopen(projection("completed", proj{stale: true}), "in_progress"), "approval", "stale reopen")
	wantTrackingError(t, AssertReopen(projection("in_progress", proj{}), "planning"), "Only completed", "not completed")

	a := appendOK(t, source("active", nil), "completed", ordered.New().Set("reason", "done").Set("noPrRationale", "docs").Set("coveredPrIds", []any{}))
	if a.Status != "completed" {
		t.Errorf("status after completion = %s", a.Status)
	}
	a = appendOK(t, source("", a), "reopened", ordered.New().Set("stage", "planning").Set("reason", "missed a step"))
	if a.Status != "active" {
		t.Errorf("status after reopen = %s", a.Status)
	}
	var types []string
	for _, e := range a.Tracking.Events {
		types = append(types, e.Type)
	}
	if !slices.Equal(types, []string{"migrated", "completed", "reopened"}) {
		t.Errorf("events = %v", types)
	}
	_, err := Append(source("", a), EventInput{Type: "reopened", Data: ordered.New().Set("stage", "completed").Set("reason", "x"), Actor: "t"}, time.Now())
	wantTrackingError(t, err, "data.stage", "reopen into completed")
	_, err = Append(source("", a), EventInput{Type: "completed", Data: ordered.New().Set("coveredPrIds", []any{}), Actor: "t"}, time.Now())
	wantTrackingError(t, err, "data.reason", "completion without reason")
}

func execution(id string) *ordered.Obj {
	machine := ordered.New().Set("installationId", id).Set("displayName", "MacBookPro").Set("hostname", "MacBookPro").Set("os", "darwin").Set("arch", "arm64")
	return ordered.New().Set("id", id).Set("provider", "claude").Set("nativeSessionId", nil).Set("role", "implementation").
		Set("machine", machine).Set("environment", ordered.New().Set("id", id).Set("type", "host"))
}

const (
	idA = "00000000-0000-4000-8000-00000000000a"
	idB = "00000000-0000-4000-8000-00000000000b"
)

func TestFirstEventRecordsMigration(t *testing.T) {
	a := appendOK(t, source("active", nil), "session.attached", ordered.New().Set("execution", execution(idA)))
	if a.Tracking.Events[0].Type != "migrated" || a.Tracking.Events[1].Type != "session.attached" {
		t.Errorf("events = %v, %v", a.Tracking.Events[0].Type, a.Tracking.Events[1].Type)
	}
	if projected(t, a, nil).Stage != "planning" {
		t.Error("active plan migrates to planning")
	}
	completed := appendOK(t, source("completed", nil), "session.attached", ordered.New().Set("execution", execution(idA)))
	if got := ordered.JSON(completed.Tracking.Events[0].Data); got != `{"stage":"completed","fromStatus":"completed","legacyCompletion":true}` {
		t.Errorf("migration data = %s", got)
	}
	if !projected(t, completed, nil).LegacyCompletion {
		t.Error("legacy completion not recorded")
	}
}

func TestIdempotencyKeys(t *testing.T) {
	input := EventInput{Type: "session.attached", Data: ordered.New().Set("execution", execution(idA)), Actor: "t", IdempotencyKey: "k"}
	first, err := Append(source("active", nil), input, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	retry, err := Append(source("", first), input, time.Now())
	if err != nil || !retry.Duplicate || len(retry.Tracking.Events) != 2 {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	input.Data = ordered.New().Set("execution", execution(idB))
	_, err = Append(source("", first), input, time.Now())
	var te *Error
	if !errors.As(err, &te) || te.Code != "ECONFLICT" {
		t.Errorf("reused key for a different change: %v", err)
	}
}

func TestMachinesSharingAHostnameStayDistinct(t *testing.T) {
	a := appendOK(t, source("active", nil), "session.attached", ordered.New().Set("execution", execution(idA)))
	a = appendOK(t, source("", a), "session.attached", ordered.New().Set("execution", execution(idB)))
	var ids []string
	for _, x := range projected(t, a, nil).Executions {
		machine, _ := x.Data.Get("machine")
		ids = append(ids, machine.(*ordered.Obj).Str("installationId"))
	}
	if !slices.Equal(ids, []string{idA, idB}) {
		t.Errorf("installations = %v", ids)
	}
}

func TestStatusMustAgreeWithStage(t *testing.T) {
	a := appendOK(t, source("active", nil), "completed", ordered.New().Set("reason", "done").Set("noPrRationale", "docs only").Set("coveredPrIds", []any{}))
	a = appendOK(t, source("", a), "reopened", ordered.New().Set("stage", "in_progress").Set("reason", "more work"))
	src := source("", a)
	src.Status = "completed"
	var te *Error
	if err := AssertStageMatchesStatus(src); !errors.As(err, &te) || te.Code != "ESTAGECONFLICT" {
		t.Errorf("contradiction: %v", err)
	}
	src.Status = "archived"
	if err := AssertStageMatchesStatus(src); err != nil {
		t.Errorf("archived is a disposition: %v", err)
	}
}

func TestValidationRejectsBadEvents(t *testing.T) {
	a := appendOK(t, source("active", nil), "stage", ordered.New().Set("stage", "planning"))
	base := a.Tracking.Events[1].Obj()
	with := func(key string, v any) *ordered.Obj { return ordered.New().Merge(base).Set(key, v) }
	_, err := ValidateEvent(with("data", ordered.New().Set("stage", "planning").Set("approvedBy", "x")), "event")
	wantTrackingError(t, err, "unsupported field", "unknown data field")
	_, err = ValidateEvent(with("extra", true), "event")
	wantTrackingError(t, err, "unsupported field", "unknown event field")
	_, err = ValidateEvent(with("data", ordered.New().Set("stage", "planning").Set("reason", strings.Repeat("x", Limits.Text+1))), "event")
	wantTrackingError(t, err, "at most", "long text")
	_, err = ValidateEvent(with("evidence", "a\x00b"), "event")
	wantTrackingError(t, err, "control characters", "control characters")
	_, err = ValidateTracking(ordered.New().Set("events", []any{base}))
	wantTrackingError(t, err, "seq must be 1", "sequence")
	many := make([]any, Limits.Events+1)
	for i := range many {
		many[i] = base
	}
	_, err = ValidateTracking(ordered.New().Set("events", many))
	wantTrackingError(t, err, "more than", "too many events")
}

func TestNewerSchemaIsRefused(t *testing.T) {
	v := 99
	_, err := Read(Source{ID: "p", Status: "active", SchemaVersion: &v, Raw: &yaml.Node{Kind: yaml.MappingNode}})
	var te *Error
	if !errors.As(err, &te) || te.Code != "EUNSUPPORTEDSCHEMA" {
		t.Errorf("schema 99: %v", err)
	}
	if SafeStage(Source{ID: "p", Status: "active", SchemaVersion: &v}) != nil {
		t.Error("an unreadable stage is unknown, not guessed")
	}
}

func TestPrURLsAreCanonicalGitHubPullRequests(t *testing.T) {
	got, err := ParsePrURL("https://github.com/hacker1db/plan-manager/pull/9/")
	if err != nil || got != (PR{Host: "github.com", Owner: "hacker1db", Repo: "plan-manager", Number: 9, URL: "https://github.com/hacker1db/plan-manager/pull/9"}) {
		t.Errorf("canonical URL: %+v %v", got, err)
	}
	for _, bad := range []string{
		"javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://github.com/a/b/pull/1", "https://u:p@github.com/a/b/pull/1",
		"https://github.com/a/b/pull/1?token=x", "https://evil.example/a/b/pull/1", "https://github.com.evil.example/a/b/pull/1",
		"https://github.com/a/b/issues/1", "https://github.com/../b/pull/1",
	} {
		if _, err := ParsePrURL(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestTrackingRoundTripsThroughYAML(t *testing.T) {
	a := appendOK(t, source("active", nil), "stage", ordered.New().Set("stage", "in_progress"))
	out, err := yaml.Marshal(a.Tracking.YAML())
	if err != nil {
		t.Fatal(err)
	}
	var n yaml.Node
	if err := yaml.Unmarshal(out, &n); err != nil {
		t.Fatal(err)
	}
	back, err := ValidateTracking(ordered.FromYAML(&n))
	if err != nil {
		t.Fatal(err)
	}
	if ordered.JSON(back.Obj()) != ordered.JSON(a.Tracking.Obj()) {
		t.Errorf("round trip changed tracking:\n%s\n%s", ordered.JSON(back.Obj()), ordered.JSON(a.Tracking.Obj()))
	}
}
