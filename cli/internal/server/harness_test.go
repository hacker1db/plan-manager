package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// planFile is frontmatter plus body for a test plan with the given id.
func planFile(id, extra, body string) string {
	return "---\nid: " + id + "\ntitle: Test plan\nstatus: active\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\ntags: []\n" + extra + "---\n" + body
}

type testServer struct {
	*Server
	t    *testing.T
	home string
}

// startServer writes files (name -> content) into a fresh plan home and
// starts a dashboard server on it.
func startServer(t *testing.T, files map[string]string) *testServer {
	t.Helper()
	home := t.TempDir()
	for name, content := range files {
		path := filepath.Join(home, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Start(Options{Host: "127.0.0.1", PlanHome: home, NoWatch: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return &testServer{Server: s, t: t, home: home}
}

// do sends a request with the dashboard's host and CSRF token and returns the
// status and body.
func (ts *testServer) do(method, path, body string) (int, string) {
	ts.t.Helper()
	port := strconv.Itoa(ts.Port)
	req, err := http.NewRequest(method, "http://127.0.0.1:"+port+path, strings.NewReader(body))
	if err != nil {
		ts.t.Fatal(err)
	}
	req.Host = "plans.localhost:" + port
	req.Header.Set("X-Csrf-Token", ts.csrf)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		ts.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(data)
}

func (ts *testServer) read(name string) string {
	ts.t.Helper()
	data, err := os.ReadFile(filepath.Join(ts.home, name))
	if err != nil {
		ts.t.Fatal(err)
	}
	return string(data)
}

func decode(t *testing.T, body string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
}
