package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef"

func startAccessServer(t *testing.T) *Server {
	t.Helper()
	home := t.TempDir()
	plan := "---\nid: access_plan\ntitle: Access\nstatus: active\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\ntags: []\n---\n\n# Body\n"
	if err := os.WriteFile(filepath.Join(home, "access.md"), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Start(Options{Host: "127.0.0.1", PlanHome: home, NoWatch: true, AccessToken: testToken})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func call(t *testing.T, s *Server, method, path string, header http.Header) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, "http://127.0.0.1:"+strconv.Itoa(s.Port)+path, strings.NewReader("{}"))
	req.Host = "plans.localhost:" + strconv.Itoa(s.Port)
	for k, v := range header {
		req.Header[k] = v
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func bearer(token string) http.Header {
	return http.Header{"Authorization": {"Bearer " + token}}
}

func csrfFor(t *testing.T, s *Server, h http.Header) string {
	t.Helper()
	res := call(t, s, http.MethodGet, "/_session", h)
	if res.StatusCode != 200 {
		t.Fatalf("/_session status %d", res.StatusCode)
	}
	var body struct {
		CSRFToken string `json:"csrfToken"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	return body.CSRFToken
}

func TestSessionRequiresDashboardAccess(t *testing.T) {
	s := startAccessServer(t)
	for name, h := range map[string]http.Header{
		"none":         nil,
		"wrong bearer": bearer("wrong"),
		"wrong cookie": {"Cookie": {accessCookie + "=" + testToken}},
		"empty bearer": bearer(""),
	} {
		if res := call(t, s, http.MethodGet, "/_session", h); res.StatusCode != 401 {
			t.Errorf("%s: /_session status %d, want 401", name, res.StatusCode)
		}
		for _, path := range []string{"/api/t3/projects", "/api/plans", "/api/search?q=a", "/api/plans/access_plan", "/_events"} {
			if res := call(t, s, http.MethodGet, path, h); res.StatusCode != 401 {
				t.Errorf("%s: %s status %d, want 401", name, path, res.StatusCode)
			}
		}
	}
	if csrfFor(t, s, bearer(testToken)) == "" {
		t.Fatal("bearer access did not return a CSRF token")
	}
	if res := call(t, s, http.MethodGet, "/api/plans/access_plan", bearer(testToken)); res.StatusCode != 200 {
		t.Fatalf("bearer detail status %d", res.StatusCode)
	}
	// Health and the static shell stay public so `plan serve` can probe the
	// port and the page can tell the user to sign in.
	if res := call(t, s, http.MethodGet, "/", nil); res.StatusCode != 200 {
		t.Fatalf("/ status %d", res.StatusCode)
	}
	if res := call(t, s, http.MethodGet, "/_health", nil); res.StatusCode != 200 {
		t.Fatalf("/_health status %d", res.StatusCode)
	}
}

func TestMutationsNeedAccessAndCSRF(t *testing.T) {
	s := startAccessServer(t)
	csrf := csrfFor(t, s, bearer(testToken))
	path := "/api/plans/access_plan/status"
	if res := call(t, s, http.MethodPost, path, http.Header{"X-Csrf-Token": {csrf}}); res.StatusCode != 401 {
		t.Errorf("CSRF without access: status %d, want 401", res.StatusCode)
	}
	if res := call(t, s, http.MethodPost, path, bearer(testToken)); res.StatusCode != 403 {
		t.Errorf("access without CSRF: status %d, want 403", res.StatusCode)
	}
	h := bearer(testToken)
	h.Set("X-Csrf-Token", csrf)
	h.Set("Content-Type", "application/json")
	if res := call(t, s, http.MethodPost, path, h); res.StatusCode == 401 || res.StatusCode == 403 {
		t.Errorf("access and CSRF: status %d", res.StatusCode)
	}
}

func TestBrowserSignInWithSingleUseTicket(t *testing.T) {
	s := startAccessServer(t)
	signIn, err := SignInURL(s.URL, s.Port, testToken, "/plans/access_plan")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(signIn, testToken) {
		t.Fatal("sign-in URL contains the access token")
	}
	u, _ := url.Parse(signIn)
	res := call(t, s, http.MethodGet, u.RequestURI(), nil)
	if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/plans/access_plan" {
		t.Fatalf("/_auth status %d location %q", res.StatusCode, res.Header.Get("Location"))
	}
	var cookie *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == accessCookie {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Value == testToken {
		t.Fatalf("cookie = %+v", cookie)
	}
	if csrfFor(t, s, http.Header{"Cookie": {cookie.Name + "=" + cookie.Value}}) == "" {
		t.Fatal("cookie access did not return a CSRF token")
	}
	// Single use.
	if res := call(t, s, http.MethodGet, u.RequestURI(), nil); res.StatusCode != 401 {
		t.Fatalf("reused ticket: status %d, want 401", res.StatusCode)
	}
}

func TestTicketsNeedBearerAndExpire(t *testing.T) {
	s := startAccessServer(t)
	cookie := http.Header{"Cookie": {accessCookie + "=" + s.cookieValue()}}
	if res := call(t, s, http.MethodPost, "/_ticket", cookie); res.StatusCode != 401 {
		t.Errorf("cookie-only ticket request: status %d, want 401", res.StatusCode)
	}
	if res := call(t, s, http.MethodPost, "/_ticket", nil); res.StatusCode != 401 {
		t.Errorf("anonymous ticket request: status %d, want 401", res.StatusCode)
	}
	s.ticketMu.Lock()
	s.tickets["expired"] = time.Now().Add(-time.Second)
	s.ticketMu.Unlock()
	if res := call(t, s, http.MethodGet, "/_auth?ticket=expired", nil); res.StatusCode != 401 {
		t.Errorf("expired ticket: status %d, want 401", res.StatusCode)
	}
	if res := call(t, s, http.MethodGet, "/_auth", nil); res.StatusCode != 401 {
		t.Errorf("missing ticket: status %d, want 401", res.StatusCode)
	}
}

func TestSafeNextStaysOnDashboard(t *testing.T) {
	for in, want := range map[string]string{
		"": "/", "/": "/", "/plans/x": "/plans/x", "//evil.example": "/", "https://evil.example": "/",
		"/\\evil.example": "/", "plans/x": "/", "/x\r\nSet-Cookie: a": "/",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAccessTokenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg", tokenFileName)
	token, err := LoadOrCreateAccessToken(path)
	if err != nil || len(token) < 32 {
		t.Fatalf("token %q err %v", token, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode %#o", info.Mode().Perm())
	}
	if dir, _ := os.Stat(filepath.Dir(path)); dir.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %#o", dir.Mode().Perm())
	}
	again, err := LoadOrCreateAccessToken(path)
	if err != nil || again != token {
		t.Fatalf("reload = %q, %v", again, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateAccessToken(path); err == nil {
		t.Fatal("accepted a group/world-readable token file")
	}
	link := filepath.Join(filepath.Dir(path), "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateAccessToken(link); err == nil {
		t.Fatal("accepted a symlinked token file")
	}
}
