package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// planBin is the plan binary the end-to-end tests run, built once.
var planBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "plan-cli-test-")
	if err != nil {
		panic(err)
	}
	planBin = filepath.Join(dir, "plan")
	if out, err := exec.Command("go", "build", "-o", planBin, "../../cmd/plan").CombinedOutput(); err != nil {
		panic(fmt.Sprintf("go build: %v\n%s", err, out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type result struct {
	code           int
	stdout, stderr string
}

// cli runs plan against an isolated plan home with a fake gh whose PR state
// and head SHA come from files, so tests can simulate pushes and merges.
type cli struct {
	t     *testing.T
	dir   string
	env   []string
	state string
	head  string
}

func newCLI(t *testing.T, prURL string) *cli {
	t.Helper()
	dir := t.TempDir()
	c := &cli{t: t, dir: dir, state: filepath.Join(dir, "pr-state"), head: filepath.Join(dir, "pr-head")}
	c.write(c.state, "OPEN")
	c.write(c.head, "ABC1234")
	gh := filepath.Join(dir, "gh")
	script := fmt.Sprintf("#!/bin/sh\nprintf '{\"url\":\"%s\",\"state\":\"%%s\",\"isDraft\":false,\"headRefOid\":\"%%s\",\"mergeCommit\":null}' \"$(cat '%s')\" \"$(cat '%s')\"\n", prURL, c.state, c.head)
	if err := os.WriteFile(gh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c.env = append(os.Environ(), "PLAN_HOME="+filepath.Join(dir, "plans"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"), "PLAN_GH="+gh)
	return c
}

func (c *cli) write(path, content string) {
	c.t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		c.t.Fatal(err)
	}
}

func (c *cli) run(stdin string, args ...string) result {
	c.t.Helper()
	cmd := exec.Command(planBin, args...)
	cmd.Env = c.env
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		c.t.Fatal(err)
	}
	return result{code, stdout.String(), stderr.String()}
}

// code runs plan and returns its exit code.
func (c *cli) code(args ...string) int {
	c.t.Helper()
	return c.run("", args...).code
}

// json runs plan, requires success, and decodes its JSON output.
func (c *cli) json(stdin string, args ...string) map[string]any {
	c.t.Helper()
	r := c.run(stdin, args...)
	if r.code != 0 {
		c.t.Fatalf("plan %s: exit %d: %s", strings.Join(args, " "), r.code, r.stderr)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil {
		c.t.Fatalf("plan %s: %v\n%s", strings.Join(args, " "), err, r.stdout)
	}
	return v
}

func field(v any, path ...string) any {
	for _, key := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[key]
	}
	return v
}

func expectCode(t *testing.T, got, want int, label string) {
	t.Helper()
	if got != want {
		t.Errorf("%s: exit %d, want %d", label, got, want)
	}
}

func TestSessionAttachIsIdempotentAndEndCloses(t *testing.T) {
	c := newCLI(t, "https://github.com/Owner/Repo/pull/7")
	c.json("", "create", "--title", "Tracked", "--json")
	details := `{"provider":"codex","nativeSessionId":"thread-1","branch":"feat/x","environment":{"type":"container","id":"00000000-0000-4000-8000-0000000000c0"}}`
	first := c.json(details, "session", "attach", "tracked", "--stdin", "--idempotency-key", "run-1", "--json")
	retry := c.json(details, "session", "attach", "tracked", "--stdin", "--idempotency-key", "run-1", "--json")
	if first["duplicate"] != false || retry["duplicate"] != true {
		t.Errorf("duplicate flags: %v, %v", first["duplicate"], retry["duplicate"])
	}
	if retry["executionId"] != first["executionId"] || retry["revision"] != first["revision"] {
		t.Error("a retry must return the same execution and revision")
	}
	if field(first, "event", "data", "execution", "environment", "type") != "container" {
		t.Error("environment type not recorded")
	}
	if field(first, "event", "data", "execution", "environment", "parentId") == nil {
		t.Error("a container records its controlling host")
	}
	expectCode(t, c.run(`{"provider":"claude","token":"x"}`, "session", "attach", "tracked", "--stdin").code, 2, "unsupported session field")
	expectCode(t, c.run(`not json`, "session", "attach", "tracked", "--stdin").code, 2, "invalid JSON")
	expectCode(t, c.code("session", "attach", "tracked"), 2, "no session details")
	id := first["executionId"].(string)
	ended := c.json("", "session", "end", "tracked", id, "--json")
	if field(ended, "event", "type") != "session.ended" {
		t.Errorf("end event = %v", field(ended, "event", "type"))
	}
	if c.json("", "session", "end", "tracked", id, "--json")["duplicate"] != true {
		t.Error("ending twice records nothing")
	}
	expectCode(t, c.code("session", "end", "tracked", "00000000-0000-4000-8000-000000000000"), 3, "unknown session")
}

func TestPrAttachVerifiesDedupesRefreshesAndDetaches(t *testing.T) {
	c := newCLI(t, "https://github.com/Owner/Repo/pull/7")
	c.json("", "create", "--title", "Tracked", "--json")
	attached := c.json("", "pr", "attach", "tracked", "https://github.com/owner/repo/pull/7", "--role", "partial", "--json")
	if attached["url"] != "https://github.com/Owner/Repo/pull/7" {
		t.Errorf("url = %v, want gh's canonical URL", attached["url"])
	}
	if c.json("", "pr", "attach", "tracked", "https://github.com/Owner/Repo/pull/7", "--json")["duplicate"] != true {
		t.Error("attaching the same PR twice must be a duplicate")
	}
	refresh := func() map[string]any { return c.json("", "pr", "refresh", "tracked", "--json") }
	if field(refresh()["prs"].([]any)[0], "changed") != false {
		t.Error("an unchanged PR refresh must not record")
	}
	c.write(c.state, "MERGED")
	refreshed := refresh()
	pr := refreshed["prs"].([]any)[0]
	if field(pr, "state") != "merged" || field(pr, "changed") != true {
		t.Errorf("refreshed PR = %v", pr)
	}
	if refreshed["stage"] != "planning" {
		t.Error("a merged PR never moves the plan stage")
	}
	expectCode(t, c.code("pr", "attach", "tracked", "https://github.com/other/repo/pull/7"), 2, "gh resolving to a different PR")
	expectCode(t, c.code("pr", "attach", "tracked", "http://github.com/a/b/pull/1"), 2, "non-canonical PR URL")
	expectCode(t, c.code("pr", "attach", "tracked", "https://github.com/owner/repo/pull/7", "--role", "owner"), 2, "invalid role")
	detached := c.json("", "pr", "detach", "tracked", attached["prId"].(string), "--json")
	if field(detached, "event", "revokes") != field(attached, "event", "id") {
		t.Error("detach must revoke the attach event")
	}
	expectCode(t, c.code("pr", "detach", "tracked", attached["prId"].(string)), 3, "detached PR")
}

func TestPrAttachNeedsGh(t *testing.T) {
	c := newCLI(t, "https://github.com/owner/repo/pull/7")
	c.json("", "create", "--title", "Tracked", "--json")
	c.env = append(c.env, "PLAN_GH="+filepath.Join(c.dir, "missing-gh"))
	expectCode(t, c.code("pr", "attach", "tracked", "https://github.com/owner/repo/pull/7"), 8, "gh unavailable")
}

func TestStageStatusAndRevisionGuards(t *testing.T) {
	c := newCLI(t, "https://github.com/owner/repo/pull/7")
	c.json("", "create", "--title", "Tracked", "--json")
	created := c.json("", "show", "tracked", "--json")
	if created["stage"] != "planning" {
		t.Errorf("new plan stage = %v", created["stage"])
	}
	expectCode(t, c.code("stage", "tracked", "shipped"), 2, "unknown stage")
	expectCode(t, c.code("stage", "tracked", "in_progress"), 2, "work cannot start before plan approval")
	rev := created["revision"].(string)
	staged := c.json("", "stage", "tracked", "awaiting_plan_review", "--if-revision", rev, "--json")
	if staged["stage"] != "awaiting_plan_review" {
		t.Errorf("stage = %v", staged["stage"])
	}
	stale := c.run("", "review", "record", "tracked", "plan", "--decision", "approved", "--if-revision", rev)
	expectCode(t, stale.code, 5, "stale revision")
	if !strings.Contains(stale.stderr, `"currentRevision"`) {
		t.Errorf("conflict stderr = %q", stale.stderr)
	}
	expectCode(t, c.code("status", "tracked", "completed"), 2, "status contradicting the stage")
	expectCode(t, c.code("stage", "tracked", "completed"), 2, "completion goes through plan complete")
	expectCode(t, c.code("stage", "missing", "planning"), 3, "unknown plan")
	text := c.run("", "stage", "tracked", "awaiting_plan_review")
	if text.code != 0 || !strings.HasPrefix(text.stdout, "Unchanged\n  revision: ") {
		t.Errorf("repeating a stage: %+v", text)
	}
}

func TestBodyUpdatesKeepTrackingAndImportsDropIt(t *testing.T) {
	c := newCLI(t, "https://github.com/owner/repo/pull/7")
	c.json("", "create", "--title", "Tracked", "--json")
	c.json("", "stage", "tracked", "awaiting_plan_review", "--json")
	c.json("# New body\n", "update", "tracked", "--stdin", "--json")
	shown := c.json("", "show", "tracked", "--json")
	if shown["stage"] != "awaiting_plan_review" {
		t.Errorf("stage after update = %v", shown["stage"])
	}
	raw, err := os.ReadFile(shown["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(c.dir, "foreign.md")
	c.write(source, regexp.MustCompile(`(?m)^title: .*$`).ReplaceAllString(string(raw), "title: Foreign"))
	imported := c.json("", "import", source, "--json")
	if imported["stage"] != "planning" {
		t.Errorf("imported stage = %v", imported["stage"])
	}
	if data, _ := os.ReadFile(imported["path"].(string)); strings.Contains(string(data), "tracking:") {
		t.Error("imports must drop foreign tracking")
	}
}

func approve(c *cli) {
	c.json("", "stage", "reviewed", "awaiting_plan_review", "--json")
	c.json("", "review", "record", "reviewed", "plan", "--decision", "approved", "--json")
}

func TestPlanApprovalGatesWorkAndCompletion(t *testing.T) {
	c := newCLI(t, "https://github.com/owner/repo/pull/7")
	c.json("", "create", "--title", "Reviewed", "--json")
	expectCode(t, c.code("review", "record", "reviewed", "plan", "--decision", "approved"), 2, "nothing was submitted")
	c.json("", "stage", "reviewed", "awaiting_plan_review", "--json")
	expectCode(t, c.code("review", "record", "reviewed", "plan", "--decision", "maybe"), 2, "unknown decision")
	if c.json("", "review", "record", "reviewed", "plan", "--decision", "changes_requested", "--json")["stage"] != "planning" {
		t.Error("changes requested must return to planning")
	}
	approve(c)
	if c.json("", "stage", "reviewed", "in_progress", "--json")["stage"] != "in_progress" {
		t.Error("approved plan must start work")
	}
	expectCode(t, c.code("complete", "reviewed", "--reason", "done"), 2, "no PRs and no rationale")
	c.json("# Changed scope\n", "update", "reviewed", "--stdin", "--json")
	stale := c.run("", "complete", "reviewed", "--reason", "done", "--no-pr-rationale", "docs only")
	expectCode(t, stale.code, 2, "stale approval")
	if !strings.Contains(stale.stderr, "body changed after approval") {
		t.Errorf("stale stderr = %q", stale.stderr)
	}
	c.json("", "stage", "reviewed", "planning", "--json")
	approve(c)
	c.json("", "stage", "reviewed", "in_progress", "--json")
	done := c.json("", "complete", "reviewed", "--reason", "done", "--no-pr-rationale", "docs only", "--json")
	if done["stage"] != "completed" || done["status"] != "completed" || field(done, "event", "data", "noPrRationale") != "docs only" {
		t.Errorf("completion = %v %v %v", done["stage"], done["status"], field(done, "event", "data"))
	}
	expectCode(t, c.code("stage", "reviewed", "planning"), 2, "reopen is explicit")
	expectCode(t, c.code("reopen", "reviewed", "--stage", "completed", "--reason", "x"), 2, "reopen into completed")
	reopened := c.json("", "reopen", "reviewed", "--stage", "planning", "--reason", "missed a case", "--json")
	if reopened["stage"] != "planning" || reopened["status"] != "active" {
		t.Errorf("reopened = %v %v", reopened["stage"], reopened["status"])
	}
	if data, _ := os.ReadFile(reopened["path"].(string)); !strings.Contains(string(data), "type: completed") {
		t.Error("completion history must be kept")
	}
}

func TestPrCompletionNeedsMergedPrWithApprovedCurrentHead(t *testing.T) {
	const pr = "https://github.com/owner/repo/pull/7"
	c := newCLI(t, pr)
	c.json("", "create", "--title", "Reviewed", "--json")
	prID := c.json("", "pr", "attach", "reviewed", pr, "--json")["prId"].(string)
	approve(c)
	c.json("", "stage", "reviewed", "in_progress", "--json")
	if c.json("", "stage", "reviewed", "awaiting_pr_review", "--json")["stage"] != "awaiting_pr_review" {
		t.Error("an open PR allows awaiting_pr_review")
	}
	expectCode(t, c.code("review", "record", "reviewed", "pr", pr, "--state", "lgtm", "--head", "abc1234"), 2, "unknown review state")
	expectCode(t, c.code("review", "record", "reviewed", "pr", pr, "--state", "approved"), 2, "head SHA is required")
	review := c.json("", "review", "record", "reviewed", "pr", pr, "--state", "approved", "--head", "ABC1234", "--json")
	if review["prId"] != prID || field(review, "event", "data", "headSha") != "abc1234" {
		t.Errorf("review = %v %v", review["prId"], field(review, "event", "data"))
	}
	expectCode(t, c.code("complete", "reviewed", "--reason", "shipped"), 2, "open PR is not merged")
	c.write(c.head, "DEF5678")
	c.write(c.state, "MERGED")
	c.json("", "pr", "refresh", "reviewed", "--json")
	stale := c.run("", "complete", "reviewed", "--reason", "shipped")
	expectCode(t, stale.code, 2, "review of an old head")
	if !strings.Contains(stale.stderr, "approved review of its current head") {
		t.Errorf("stale stderr = %q", stale.stderr)
	}
	c.json("", "review", "record", "reviewed", "pr", prID, "--state", "approved", "--head", "def5678", "--json")
	done := c.json("", "complete", "reviewed", "--reason", "shipped", "--json")
	covered := field(done, "event", "data", "coveredPrIds").([]any)
	if len(covered) != 1 || covered[0] != prID || done["status"] != "completed" {
		t.Errorf("completion = %v %v", covered, done["status"])
	}
}

func TestCreateFormatMDX(t *testing.T) {
	c := newCLI(t, "")
	created := c.json("<Callout tone=\"decision\">\nShip it\n</Callout>\n", "create", "--title", "Visual Plan", "--format", "mdx", "--stdin", "--json")
	path := created["path"].(string)
	if !strings.HasSuffix(path, "/visual-plan.mdx") {
		t.Errorf("path = %s", path)
	}
	raw, _ := os.ReadFile(path)
	if !regexp.MustCompile(`(?m)^format: mdx$`).Match(raw) || !strings.Contains(string(raw), `<Callout tone="decision">`) {
		t.Errorf("file:\n%s", raw)
	}
	if c.json("", "show", "visual-plan", "--json")["id"] != created["id"] {
		t.Error("show by slug")
	}
	source := filepath.Join(c.dir, "source.mdx")
	c.write(source, "# From file\n")
	if p := c.json("", "create", "--title", "From File", "--file", source, "--json")["path"].(string); !strings.HasSuffix(p, "/from-file.mdx") {
		t.Errorf("format inferred from --file: %s", p)
	}
	bad := c.run("", "create", "--title", "Bad", "--format", "html")
	expectCode(t, bad.code, 2, "unknown format")
	if !strings.Contains(bad.stderr, "--format must be md or mdx") {
		t.Errorf("stderr = %q", bad.stderr)
	}
	archived := c.json("", "archive", created["id"].(string), "--json")
	if !strings.HasSuffix(archived["path"].(string), "/archive/visual-plan.mdx") {
		t.Errorf("archive keeps .mdx: %s", archived["path"])
	}
	imported := c.json("", "import", source, "--json")
	if !strings.HasSuffix(imported["path"].(string), ".mdx") {
		t.Errorf("import keeps .mdx: %s", imported["path"])
	}
}

func TestBlocksAndCheck(t *testing.T) {
	c := newCLI(t, "")
	text := c.run("", "blocks")
	if text.code != 0 || !strings.Contains(text.stdout, "## <Diff>") {
		t.Errorf("blocks: %+v", text)
	}
	catalog := c.json("", "blocks", "--json")
	if catalog["version"] != float64(1) || len(catalog["blocks"].([]any)) == 0 {
		t.Errorf("blocks --json = %v", catalog)
	}
	good := filepath.Join(c.dir, "good.mdx")
	bad := filepath.Join(c.dir, "bad.mdx")
	c.write(good, "---\nformat: mdx\n---\n<Callout>\nfine\n</Callout>\n")
	c.write(bad, "<Diff filename=\"a\" />\n\n<Nope />\n")
	expectCode(t, c.code("check", good), 0, "valid MDX")
	failed := c.run("", "check", good, bad, "--json")
	expectCode(t, failed.code, 2, "invalid MDX")
	var report struct {
		Results []struct {
			OK       bool     `json:"ok"`
			Problems []string `json:"problems"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(failed.stdout), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Results) != 2 || !report.Results[0].OK || report.Results[1].OK || len(report.Results[1].Problems) != 2 {
		t.Errorf("report = %+v", report)
	}
	plain := c.run("", "check", bad)
	if !strings.Contains(plain.stdout, "FAIL  "+bad) || !strings.Contains(plain.stdout, "  - Unknown block <Nope>") || plain.stderr != "" {
		t.Errorf("text report: %+v", plain)
	}
	created := c.json("", "create", "--title", "Checked", "--format", "mdx", "--json")
	expectCode(t, c.code("check", created["id"].(string)), 0, "check by plan id")
	expectCode(t, c.code("check", "missing-plan"), 3, "unknown plan")
	expectCode(t, c.code("check"), 2, "no target")
}
