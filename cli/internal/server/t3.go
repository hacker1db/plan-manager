package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// T3 Code integration: start a T3 thread that works on a plan. The dashboard
// only ever runs the `t3` CLI with fixed subcommands and validated arguments;
// the agent message is passed on stdin, never through a shell.

const t3Timeout = 30 * time.Second

var (
	t3Ref       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/@-]{0,200}$`)
	t3ProjectID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_:.-]{0,200}$`)
	t3Route     = regexp.MustCompile(`^/api/plans/([^/]+)/t3$`)
)

type t3Project struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Root       string `json:"root"`
	BaseBranch string `json:"baseBranch"`
}

// t3Binary finds the t3 CLI. A launchd-started server may not have Homebrew on
// PATH, so the usual install locations are checked too. PLAN_T3_BIN overrides.
func t3Binary() string {
	if v := os.Getenv("PLAN_T3_BIN"); v != "" {
		return v
	}
	if p, err := exec.LookPath("t3"); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{filepath.Join(home, ".t3", "bin", "t3"), "/opt/homebrew/bin/t3", "/usr/local/bin/t3"} {
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

func t3Home() string {
	if v := os.Getenv("T3CODE_HOME"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".t3")
}

// t3Projects lists T3 Code projects, newest first, by reading its state
// database read-only. It is best effort: the dialog still accepts a folder.
func t3Projects() []t3Project {
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		return nil
	}
	for _, name := range []string{"statev2.sqlite", "state.sqlite"} {
		db := filepath.Join(t3Home(), "userdata", name)
		if _, err := os.Stat(db); err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, sqlite, "-readonly", "-json", "file:"+db+"?mode=ro",
			"select project_id as id, title, workspace_root as root from projection_projects "+
				"where deleted_at is null and archived_at is null order by updated_at desc").Output()
		cancel()
		if err != nil {
			continue
		}
		var list []t3Project
		if json.Unmarshal(out, &list) != nil {
			continue
		}
		for i := range list {
			list[i].BaseBranch = defaultBranch(list[i].Root)
		}
		return list
	}
	return nil
}

// defaultBranch guesses the branch a new worktree should start from.
func defaultBranch(root string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").Output()
	if err == nil {
		if b := strings.TrimPrefix(strings.TrimSpace(string(out)), "origin/"); t3Ref.MatchString(b) {
			return b
		}
	}
	for _, b := range []string{"main", "master"} {
		if exec.CommandContext(ctx, "git", "-C", root, "rev-parse", "--verify", "--quiet", b).Run() == nil {
			return b
		}
	}
	return "HEAD"
}

// suggestProject picks the project whose folder contains the plan's source.
func suggestProject(projects []t3Project, source string) string {
	best, bestLen := "", 0
	for _, p := range projects {
		root := filepath.Clean(p.Root)
		if source == root || strings.HasPrefix(source, root+string(filepath.Separator)) {
			if len(root) > bestLen {
				best, bestLen = p.ID, len(root)
			}
		}
	}
	return best
}

func (s *Server) serveT3Projects(w http.ResponseWriter, r *http.Request) {
	bin := t3Binary()
	projects := []t3Project{}
	if bin != "" {
		if list := t3Projects(); list != nil {
			projects = list
		}
	}
	suggested := ""
	if source := r.URL.Query().Get("source"); source != "" {
		suggested = suggestProject(projects, filepath.Clean(source))
	}
	writeJSON(w, 200, map[string]any{"available": bin != "", "projects": projects, "suggested": suggested})
}

func (s *Server) startT3Thread(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Project  string `json:"project"`
		Title    string `json:"title"`
		Message  string `json:"message"`
		Worktree string `json:"worktree"`
		Open     bool   `json:"open"`
	}
	if !readBody(w, r, &body) {
		return
	}
	bin := t3Binary()
	if bin == "" {
		writeError(w, 503, "T3 Code CLI (t3) not found")
		return
	}
	p, err := s.findPlan(id)
	if err != nil || p == nil {
		writeError(w, 404, "plan not found")
		return
	}
	message := strings.TrimSpace(body.Message)
	title := strings.Join(strings.Fields(body.Title), " ")
	if message == "" || len(title) > 200 || strings.ContainsRune(message, 0) {
		writeError(w, 400, "invalid thread request")
		return
	}

	if body.Worktree != "" && !t3Ref.MatchString(body.Worktree) {
		writeError(w, 400, "invalid worktree base")
		return
	}

	// The project is a known T3 project id or an existing absolute folder.
	known := t3Projects()
	project, root, registerDir := "", "", ""
	for _, k := range known {
		if k.ID == body.Project {
			project, root = k.ID, k.Root
		}
	}
	if project == "" {
		dir := filepath.Clean(body.Project)
		if info, err := os.Stat(dir); err == nil && info.IsDir() && filepath.IsAbs(dir) {
			project, root = dir, dir
			// T3 only starts threads inside projects it knows about.
			if suggestProject(known, dir) == "" {
				registerDir = dir
			}
		} else if t3ProjectID.MatchString(body.Project) {
			project = body.Project
		} else {
			writeError(w, 400, "choose a T3 project or an existing folder")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), t3Timeout)
	defer cancel()
	registered := false
	if registerDir != "" {
		if out, err := exec.CommandContext(ctx, bin, "project", "add", "--", registerDir).CombinedOutput(); err != nil {
			msg := strings.TrimSpace(string(out))
			if msg == "" {
				msg = err.Error()
			}
			writeError(w, 502, "could not add the folder as a T3 project: "+firstLines(msg, 6))
			return
		}
		registered = true
	}

	args := []string{"thread", "start", "--json"}
	if title != "" {
		args = append(args, "--title="+title)
	}
	if body.Worktree != "" {
		args = append(args, "--worktree="+body.Worktree)
	}
	// "--" ends flag parsing, so neither positional can be read as a flag.
	args = append(args, "--", project, "-")
	c := exec.CommandContext(ctx, bin, args...)
	c.Stdin = strings.NewReader(message)
	var stdout, stderr bytes.Buffer
	c.Stdout = &limitedWriter{w: &stdout, n: 256 * 1024}
	c.Stderr = &limitedWriter{w: &stderr, n: 64 * 1024}
	if err := c.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			msg = "t3 thread start failed: " + err.Error()
		}
		writeError(w, 502, firstLines(msg, 6))
		return
	}

	var thread map[string]any
	_ = json.Unmarshal(stdout.Bytes(), &thread)
	threadID := ""
	for _, key := range []string{"threadId", "id", "thread_id"} {
		if v, ok := thread[key].(string); ok && v != "" {
			threadID = v
			break
		}
	}
	if threadID == "" && thread == nil {
		threadID = strings.TrimSpace(stdout.String())
	}

	opened := false
	if body.Open && root != "" {
		o := exec.Command(bin, "app", "--", root)
		o.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if o.Start() == nil {
			opened = true
			go o.Wait()
		}
	}
	writeJSON(w, 200, map[string]any{"id": id, "threadId": threadID, "thread": thread, "project": project, "registered": registered, "opened": opened})
}

func firstLines(v string, n int) string {
	lines := strings.Split(v, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}
