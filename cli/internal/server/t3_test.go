package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSuggestProjectPrefersDeepestRoot(t *testing.T) {
	projects := []t3Project{{ID: "a", Root: "/dev/repo"}, {ID: "b", Root: "/dev/repo/main"}, {ID: "c", Root: "/dev/repo-other"}}
	if got := suggestProject(projects, "/dev/repo/main/docs/plan.md"); got != "b" {
		t.Fatalf("suggested %q", got)
	}
	if got := suggestProject(projects, "/dev/repo-otherish/x.md"); got != "" {
		t.Fatalf("prefix without separator matched %q", got)
	}
}

// A fake t3 records its arguments and stdin so the exact invocation is checked.
func TestStartT3ThreadInvokesCLIWithoutShell(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	dir := t.TempDir()
	record := filepath.Join(dir, "record")
	fake := filepath.Join(dir, "t3")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" '----' >> " + record + ".args\nif [ \"$1\" = thread ]; then cat > " + record + ".stdin; fi\necho '{\"threadId\":\"thr_123\"}'\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PLAN_T3_BIN", fake)
	t.Setenv("T3CODE_HOME", filepath.Join(dir, "no-t3-home"))

	home := t.TempDir()
	plan := "---\nid: t3_plan\ntitle: T3 plan\nstatus: active\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\ntags: []\n---\n\n# Body\n"
	if err := os.WriteFile(filepath.Join(home, "t3.md"), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{home: home, archive: filepath.Join(home, "archive")}

	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.startT3Thread(w, httptest.NewRequest(http.MethodPost, "/api/plans/t3_plan/t3", strings.NewReader(body)), "t3_plan")
		return w
	}

	project := t.TempDir()
	w := post(`{"project":` + mustJSON(project) + `,"title":"Run  it","message":"Do the plan; $(rm -rf /)","worktree":"main"}`)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var res map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res["threadId"] != "thr_123" || res["registered"] != true {
		t.Fatalf("threadId = %v", res["threadId"])
	}
	args, _ := os.ReadFile(record + ".args")
	// An unknown folder is registered with T3 before the thread starts.
	want := strings.Join([]string{
		"project", "add", "--", project, "----",
		"thread", "start", "--json", "--title=Run it", "--worktree=main", "--", project, "-", "----",
	}, "\n") + "\n"
	if string(args) != want {
		t.Fatalf("args =\n%s\nwant\n%s", args, want)
	}
	if stdin, _ := os.ReadFile(record + ".stdin"); string(stdin) != "Do the plan; $(rm -rf /)" {
		t.Fatalf("stdin = %q", stdin)
	}

	for _, bad := range []string{
		`{"project":"--help","message":"x"}`,
		`{"project":` + mustJSON(project) + `,"message":"x","worktree":"--upload-pack=evil"}`,
		`{"project":` + mustJSON(project) + `,"message":"  "}`,
	} {
		if w := post(bad); w.Code != 400 {
			t.Errorf("%s -> %d, want 400", bad, w.Code)
		}
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
