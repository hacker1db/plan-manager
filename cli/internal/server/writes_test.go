package server

import (
	"strings"
	"testing"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/tracking"
)

// completedPlan is a tracked plan whose journey stage is completed.
func completedPlan(t *testing.T, id string) string {
	t.Helper()
	meta := plans.Meta{ID: id, Title: "Tracked", Status: plans.StatusActive, Created: "2026-01-01T00:00:00.000Z", Updated: "2026-01-01T00:00:00.000Z", Tags: []string{}}
	data := ordered.New().Set("reason", "done").Set("noPrRationale", "docs only").Set("coveredPrIds", []any{})
	a, err := tracking.Append(meta.TrackingSource(), tracking.EventInput{Type: "completed", Data: data, Actor: "tester"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	v := tracking.SchemaVersion
	meta.Status, meta.SchemaVersion, meta.Tracking = a.Status, &v, a.Tracking.YAML()
	content, err := plans.Render(meta, "Body\n")
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func TestStatusChangeMustAgreeWithTrackedStage(t *testing.T) {
	before := completedPlan(t, "tracked_plan")
	ts := startServer(t, map[string]string{"tracked.md": before})
	status, res := ts.do("POST", "/api/plans/tracked_plan/status", `{"status":"active"}`)
	if status != 409 || !strings.Contains(res, "contradicts tracked stage") {
		t.Fatalf("status %d: %s", status, res)
	}
	if ts.read("tracked.md") != before {
		t.Fatal("refused status change modified the plan")
	}
}

func TestDashboardRefusesNewerTrackingSchema(t *testing.T) {
	before := planFile("future_plan", "schemaVersion: 99\ntracking: {events: []}\n", "- [ ] Task\n")
	ts := startServer(t, map[string]string{"future.md": before})
	status, res := ts.do("POST", "/api/plans/future_plan/status", `{"status":"completed"}`)
	if status != 409 || !strings.Contains(res, "tracking schema 99") {
		t.Fatalf("status: %d %s", status, res)
	}
	_, detail := ts.do("GET", "/api/plans/future_plan", "")
	var plan struct {
		Revision string `json:"revision"`
	}
	decode(t, detail, &plan)
	if status, res := ts.do("POST", "/api/plans/future_plan/tasks/0", `{"checked":true,"revision":"`+plan.Revision+`"}`); status != 409 {
		t.Fatalf("task: %d %s", status, res)
	}
	if status, res := ts.do("POST", "/api/plans/future_plan/archive", ""); status != 409 {
		t.Fatalf("archive: %d %s", status, res)
	}
	if ts.read("future.md") != before {
		t.Fatal("refused writes modified the plan")
	}
}
