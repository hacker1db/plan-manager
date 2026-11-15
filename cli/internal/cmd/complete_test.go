package cmd

import (
	"testing"

	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

func values(s []string) map[string]bool {
	m := map[string]bool{}
	for _, v := range s {
		m[v] = true
	}
	return m
}

func suggest(line string) map[string]bool {
	var out []string
	for _, s := range Complete(line) {
		out = append(out, s.Value)
	}
	return values(out)
}

func TestCompleteCommandsAndArguments(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	if _, err := CreatePlan(newMeta("Migrate auth service"), "", "md"); err != nil {
		t.Fatal(err)
	}

	if got := suggest("sta"); !got["status"] || got["show"] {
		t.Errorf("prefix completion: %v", got)
	}
	if got := suggest(""); !got["archive"] || !got["tui"] || got["help"] || got["completion"] {
		t.Errorf("top-level commands: %v", got)
	}
	if got := suggest("status "); !got["migrate-auth-service"] {
		t.Errorf("plan slug after a space: %v", got)
	}
	if got := suggest("status migrate-auth-service "); !got["completed"] || !got["archived"] {
		t.Errorf("status values after the plan: %v", got)
	}
	if got := suggest("list --status "); !got["all"] {
		t.Errorf("flag values: %v", got)
	}
	if got := suggest("auth "); !got["login"] || !got["logout"] {
		t.Errorf("auth subcommands: %v", got)
	}
}

func TestPlanCandidatesUseIDForAmbiguousSlug(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	if err := plans.InitStorage(); err != nil {
		t.Fatal(err)
	}
	for i, p := range []string{plans.PlanPath("dup", "md"), plans.ArchivePath("dup", "md")} {
		m := plans.Meta{ID: []string{"id-one", "id-two"}[i], Title: "Dup", Status: "active", Tags: []string{}}
		if err := plans.Write(p, m, ""); err != nil {
			t.Fatal(err)
		}
	}
	got := map[string]bool{}
	for _, c := range planCandidates(true) {
		got[c[:6]] = true
	}
	if !got["id-one"] || !got["id-two"] {
		t.Fatalf("expected IDs for ambiguous slug: %v", planCandidates(true))
	}
}
