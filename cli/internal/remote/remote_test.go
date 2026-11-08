package remote

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeSecurity = `#!/bin/sh
action="$1"; shift
case "$action" in
  add-generic-password)
    # Like the real tool with a trailing -w: the password arrives on stdin
    # (entered twice), never in argv. Record argv so tests can prove the
    # secret is not exposed on the process argument list.
    printf '%s\n' "$@" > "$PLAN_MANAGER_TEST_KEYCHAIN.argv"
    for last; do :; done
    [ "$last" = "-w" ] || exit 2
    IFS= read -r first; IFS= read -r second
    [ "$first" = "$second" ] || exit 1
    printf '%s' "$first" > "$PLAN_MANAGER_TEST_KEYCHAIN" ;;
  find-generic-password)
    [ -f "$PLAN_MANAGER_TEST_KEYCHAIN" ] || exit 1
    cat "$PLAN_MANAGER_TEST_KEYCHAIN" ;;
  delete-generic-password)
    rm -f "$PLAN_MANAGER_TEST_KEYCHAIN" ;;
esac
`

func withKeychain(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := filepath.Join(dir, "security")
	if err := os.WriteFile(cmd, []byte(fakeSecurity), 0o700); err != nil {
		t.Fatal(err)
	}
	keychain := filepath.Join(dir, "keychain")
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("PLAN_MANAGER_SECURITY_COMMAND", cmd)
	t.Setenv("PLAN_MANAGER_TEST_KEYCHAIN", keychain)
	return keychain
}

// fakeClerk serves the site config, OAuth metadata, and token endpoint.
func fakeClerk(t *testing.T, token http.HandlerFunc) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"clientId": "oauthapp_public", "issuerUrl": srv.URL})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"authorization_endpoint": srv.URL + "/oauth/authorize", "token_endpoint": srv.URL + "/oauth/token"})
	})
	mux.HandleFunc("/oauth/token", token)
	srv = httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	prev := httpClient
	httpClient = srv.Client()
	t.Cleanup(func() { httpClient = prev })
	t.Setenv("PLAN_MANAGER_URL", srv.URL)
	return srv
}

// urlCatcher captures the authorization URL Login prints.
type urlCatcher struct {
	mu   sync.Mutex
	buf  strings.Builder
	seen chan string
}

var openLine = regexp.MustCompile(`Open: (https://\S+)`)

func (c *urlCatcher) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf.Write(p)
	if m := openLine.FindStringSubmatch(c.buf.String()); m != nil {
		select {
		case c.seen <- m[1]:
		default:
		}
	}
	return len(p), nil
}

func startLogin(t *testing.T) (authorize *url.URL, callback string, done chan error) {
	t.Helper()
	site, err := GetSite()
	if err != nil {
		t.Fatal(err)
	}
	catcher := &urlCatcher{seen: make(chan string, 1)}
	done = make(chan error, 1)
	go func() { done <- Login(site, catcher) }()
	select {
	case raw := <-catcher.seen:
		authorize, _ = url.Parse(raw)
	case err := <-done:
		t.Fatalf("login ended early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no authorization URL printed")
	}
	return authorize, authorize.Query().Get("redirect_uri"), done
}

func visit(t *testing.T, u string) int {
	t.Helper()
	res, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestPKCELoginStoresCredential(t *testing.T) {
	keychain := withKeychain(t)
	var authorize *url.URL
	fakeClerk(t, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "authorization-code" {
			t.Errorf("unexpected token request: %v", r.Form)
		}
		if r.Form.Get("redirect_uri") != authorize.Query().Get("redirect_uri") {
			t.Error("redirect_uri mismatch")
		}
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if authorize.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(sum[:]) {
			t.Error("code_challenge does not match verifier")
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "clerk-access-token", "refresh_token": "clerk-refresh-token", "token_type": "Bearer", "expires_in": 3600})
	})
	var callback string
	var done chan error
	authorize, callback, done = startLogin(t)
	q := authorize.Query()
	if q.Get("response_type") != "code" || q.Get("scope") != "openid offline_access" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("bad authorize query: %v", q)
	}
	cb, _ := url.Parse(callback)
	if cb.Scheme != "http" || cb.Hostname() != "127.0.0.1" {
		t.Fatalf("callback must be loopback http: %s", callback)
	}
	state := url.QueryEscape(q.Get("state"))
	for _, c := range []struct {
		query string
		want  int
	}{
		{"code=wrong-code&state=wrong-state", 400},
		{"error=access_denied&state=wrong-state", 400},
		{"state=" + state, 400},
		{"code=authorization-code&state=" + state, 200},
	} {
		if got := visit(t, callback+"?"+c.query); got != c.want {
			t.Errorf("callback %s = %d, want %d", c.query, got, c.want)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var stored storedOAuth
	data, _ := os.ReadFile(keychain)
	if err := json.Unmarshal(data, &stored); err != nil || stored.AccessToken != "clerk-access-token" || stored.RefreshToken != "clerk-refresh-token" || stored.ClientID != "oauthapp_public" {
		t.Fatalf("bad stored credential: %s", data)
	}
}

func TestStoreCredentialKeepsSecretOutOfArgv(t *testing.T) {
	keychain := withKeychain(t)
	token := "pm_" + strings.Repeat("a", 18) + "_" + strings.Repeat("b", 43)
	if err := StoreLegacyToken(token); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(keychain); string(data) != token {
		t.Fatalf("credential not stored via stdin: %s", data)
	}
	argv, err := os.ReadFile(keychain + ".argv")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(argv), token) {
		t.Fatalf("secret leaked into security(1) argv: %s", argv)
	}
	fields := strings.Fields(string(argv))
	if len(fields) == 0 || fields[len(fields)-1] != "-w" {
		t.Fatalf("security must read the secret from stdin via a trailing -w; argv=%s", argv)
	}
}

func TestPKCELoginRejectsProviderError(t *testing.T) {
	withKeychain(t)
	fakeClerk(t, func(w http.ResponseWriter, r *http.Request) { t.Error("token endpoint should not be called") })
	authorize, callback, done := startLogin(t)
	if got := visit(t, callback+"?error=access_denied&state="+url.QueryEscape(authorize.Query().Get("state"))); got != 400 {
		t.Fatalf("status %d", got)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "Clerk authorization failed: access_denied") {
		t.Fatalf("got %v", err)
	}
}

func TestFailedTokenExchangeStoresNothing(t *testing.T) {
	keychain := withKeychain(t)
	fakeClerk(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
	})
	authorize, callback, done := startLogin(t)
	if got := visit(t, callback+"?code=authorization-code&state="+url.QueryEscape(authorize.Query().Get("state"))); got != 200 {
		t.Fatalf("status %d", got)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(keychain); !os.IsNotExist(err) {
		t.Fatal("credential should not be stored")
	}
}

func TestExpiredAccessTokenRefreshes(t *testing.T) {
	keychain := withKeychain(t)
	srv := fakeClerk(t, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh-token" {
			t.Errorf("unexpected refresh request: %v", r.Form)
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access-token", "refresh_token": "new-refresh-token", "token_type": "Bearer", "expires_in": 3600})
	})
	old, _ := json.Marshal(storedOAuth{Version: 1, AccessToken: "expired-access-token", RefreshToken: "old-refresh-token",
		AccessTokenExpiresAt: time.Now().UnixMilli() - 1000, TokenEndpoint: srv.URL + "/oauth/token", ClientID: "oauthapp_public"})
	os.WriteFile(keychain, old, 0o600)
	tok, err := TokenFromKeychain()
	if err != nil || tok != "new-access-token" {
		t.Fatalf("got %q, %v", tok, err)
	}
	var stored storedOAuth
	data, _ := os.ReadFile(keychain)
	json.Unmarshal(data, &stored)
	if stored.RefreshToken != "new-refresh-token" || stored.AccessTokenExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("rotated pair not saved: %s", data)
	}
}

func TestGetSiteRejectsNonBareHTTPS(t *testing.T) {
	for _, v := range []string{"http://example.com", "https://example.com/path", "https://u:p@example.com", "https://example.com?q=1"} {
		t.Setenv("PLAN_MANAGER_URL", v)
		if _, err := GetSite(); err == nil {
			t.Errorf("%s should be rejected", v)
		}
	}
	t.Setenv("PLAN_MANAGER_URL", "https://Example.com/")
	if s, err := GetSite(); err != nil || s.URL != "https://example.com" {
		t.Errorf("got %v %v", s, err)
	}
}
