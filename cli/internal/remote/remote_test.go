package remote

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fakeSecurity = `#!/bin/sh
action="$1"; shift
service=""
prev=""
for arg in "$@"; do [ "$prev" = "-s" ] && service="$arg"; prev="$arg"; done
case "$action" in
  add-generic-password)
    while [ $# -gt 0 ]; do
      if [ "$1" = "-w" ]; then
        [ $# -eq 1 ] || exit 2
        IFS= read -r password
        printf '%s' "$password" > "$PLAN_MANAGER_TEST_KEYCHAIN"
        printf '%s' "$service" > "$PLAN_MANAGER_TEST_KEYCHAIN.service"
      fi
      shift
    done ;;
  find-generic-password)
    [ -f "$PLAN_MANAGER_TEST_KEYCHAIN" ] || exit 1
    if [ -f "$PLAN_MANAGER_TEST_KEYCHAIN.service" ] && [ "$(cat "$PLAN_MANAGER_TEST_KEYCHAIN.service")" != "$service" ]; then exit 44; fi
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

func fakeWorkOS(t *testing.T, device, token http.HandlerFunc) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"version": 2, "clientId": "client_cli", "issuerUrl": srv.URL,
			"audience": "https://plans.example/api/v1", "scope": "plans:write",
			"deviceAuthorizationEndpoint": srv.URL + "/oauth2/device_authorization",
			"tokenEndpoint":               srv.URL + "/oauth2/token",
			"jwksUrl":                     srv.URL + "/oauth2/jwks",
		})
	})
	mux.HandleFunc("/oauth2/device_authorization", device)
	mux.HandleFunc("/oauth2/token", token)
	srv = httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	previousClient := httpClient
	httpClient = srv.Client()
	httpClient.CheckRedirect = rejectRedirect
	t.Cleanup(func() { httpClient = previousClient })
	t.Setenv("PLAN_MANAGER_URL", srv.URL)
	return srv
}

func TestDeviceLoginStoresVersionedCredentialWithoutPrintingDeviceCode(t *testing.T) {
	keychain := withKeychain(t)
	polls := 0
	var waits []time.Duration
	fakeWorkOS(t, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("client_id") != "client_cli" || r.Form.Get("scope") != "openid offline_access plans:write" {
			t.Errorf("unexpected device request: %v", r.Form)
		}
		json.NewEncoder(w).Encode(map[string]any{"device_code": "secret-device-code", "user_code": "ABCD-EFGH", "verification_uri": "https://" + r.Host + "/activate", "expires_in": 600, "interval": 1})
	}, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || r.Form.Get("device_code") != "secret-device-code" {
			t.Errorf("unexpected token request: %v", r.Form)
		}
		polls++
		if polls == 1 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "slow_down"})
			return
		}
		if polls == 2 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "access-token", "refresh_token": "refresh-token", "token_type": "Bearer", "expires_in": 3600})
	})
	previousWait := pollWait
	pollWait = func(value time.Duration) { waits = append(waits, value) }
	t.Cleanup(func() { pollWait = previousWait })
	site, err := GetSite()
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := Login(site, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Code: ABCD-EFGH") || strings.Contains(output.String(), "secret-device-code") {
		t.Fatalf("unsafe login output: %s", output.String())
	}
	if len(waits) != 2 || waits[0] != 6*time.Second || waits[1] != 6*time.Second {
		t.Fatalf("unexpected poll delays: %v", waits)
	}
	var stored storedOAuth
	data, _ := os.ReadFile(keychain)
	if err := json.Unmarshal(data, &stored); err != nil || stored.Version != 2 || stored.Provider != "workos-cli" || stored.Scope != "plans:write" || stored.SiteURL != site.URL {
		t.Fatalf("bad stored credential: %s", data)
	}
}

func TestDeviceDenialStoresNothing(t *testing.T) {
	keychain := withKeychain(t)
	fakeWorkOS(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "CODE", "verification_uri": "https://" + r.Host + "/activate", "expires_in": 600})
	}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "access_denied", "error_description": "User denied access"})
	})
	site, _ := GetSite()
	if err := Login(site, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "User denied access") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(keychain); !os.IsNotExist(err) {
		t.Fatal("credential should not be stored")
	}
}

func TestVersionOneClerkCredentialRequiresRelogin(t *testing.T) {
	keychain := withKeychain(t)
	os.WriteFile(keychain, []byte(`{"version":1,"accessToken":"old"}`), 0o600)
	if _, err := TokenFromKeychain(Site{URL: "https://plans.example"}); err == nil || !strings.Contains(err.Error(), "Stored Clerk credential is obsolete") {
		t.Fatalf("got %v", err)
	}
}

func TestExpiredWorkOSTokenRequiresAndSavesRotatedPair(t *testing.T) {
	keychain := withKeychain(t)
	srv := fakeWorkOS(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("device endpoint should not be called") }, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh" {
			t.Errorf("unexpected refresh request: %v", r.Form)
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "new-access", "refresh_token": "new-refresh", "token_type": "Bearer", "expires_in": 3600})
	})
	site, _ := GetSite()
	old, _ := json.Marshal(storedOAuth{Version: 2, Provider: "workos-cli", SiteURL: site.URL, AccessToken: "expired", RefreshToken: "old-refresh",
		AccessTokenExpiresAt: time.Now().UnixMilli() - 1000, TokenEndpoint: srv.URL + "/oauth2/token", ClientID: "client_cli",
		IssuerURL: srv.URL, Audience: "https://plans.example/api/v1", Scope: "plans:write"})
	os.WriteFile(keychain, old, 0o600)
	token, err := TokenFromKeychain(site)
	if err != nil || token != "new-access" {
		t.Fatalf("got %q, %v", token, err)
	}
	var stored storedOAuth
	data, _ := os.ReadFile(keychain)
	json.Unmarshal(data, &stored)
	if stored.RefreshToken != "new-refresh" || stored.AccessTokenExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("rotated pair not saved: %s", data)
	}
}

func TestGetSiteRejectsNonBareHTTPS(t *testing.T) {
	for _, value := range []string{"http://example.com", "https://example.com/path", "https://u:p@example.com", "https://example.com?q=1"} {
		t.Setenv("PLAN_MANAGER_URL", value)
		if _, err := GetSite(); err == nil {
			t.Errorf("%s should be rejected", value)
		}
	}
	t.Setenv("PLAN_MANAGER_URL", "https://Example.com/")
	if site, err := GetSite(); err != nil || site.URL != "https://example.com" {
		t.Errorf("got %v %v", site, err)
	}
}

func TestPushRejectsRedirectWithoutForwardingBearerOrBody(t *testing.T) {
	var received bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = true
		w.WriteHeader(http.StatusNoContent)
	}))
	defer destination.Close()

	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	previousClient := httpClient
	httpClient = origin.Client()
	httpClient.CheckRedirect = rejectRedirect
	t.Cleanup(func() { httpClient = previousClient })

	_, err := Push(Site{URL: origin.URL}, "pm_example_secret", PushPayload{ID: "plan-1", Markdown: "private"})
	if err == nil || !strings.Contains(err.Error(), "Push failed (307)") {
		t.Fatalf("expected redirect rejection, got %v", err)
	}
	if received {
		t.Fatal("redirect destination received bearer or body")
	}
}

func TestCredentialsAreBoundToSiteOrigin(t *testing.T) {
	keychain := withKeychain(t)
	refreshed := false
	srv := fakeWorkOS(t, func(w http.ResponseWriter, r *http.Request) {}, func(w http.ResponseWriter, r *http.Request) { refreshed = true })
	site, _ := GetSite()
	oauth := storedOAuth{Version: 2, Provider: "workos-cli", AccessToken: "expired", RefreshToken: "secret-refresh",
		AccessTokenExpiresAt: time.Now().UnixMilli() - 1000, TokenEndpoint: srv.URL + "/oauth2/token", ClientID: "client_cli",
		IssuerURL: srv.URL, Audience: "https://plans.example/api/v1", Scope: "plans:write"}
	// Unbound records (pre-namespacing) and records for another origin require a new login.
	unbound, _ := json.Marshal(oauth)
	oauth.SiteURL = "https://attacker.example"
	other, _ := json.Marshal(oauth)
	for _, value := range [][]byte{unbound, other, []byte("pm_abcdefgh_" + strings.Repeat("a", 32))} {
		os.WriteFile(keychain, value, 0o600)
		if _, err := TokenFromKeychain(site); err == nil || !strings.Contains(err.Error(), "not bound to this site") {
			t.Fatalf("%s: got %v", value, err)
		}
	}
	if refreshed {
		t.Fatal("refresh token was sent for an unbound credential")
	}
	token := "pm_abcdefgh_" + strings.Repeat("b", 32)
	if err := StoreLegacyToken(site, token); err != nil {
		t.Fatal(err)
	}
	if svc, _ := os.ReadFile(keychain + ".service"); string(svc) != "plan-manager:site:"+site.URL {
		t.Fatalf("bad service %q", svc)
	}
	var stored storedLegacy
	data, _ := os.ReadFile(keychain)
	if json.Unmarshal(data, &stored) != nil || stored.Provider != "legacy-token" || stored.SiteURL != site.URL || stored.Token != token {
		t.Fatalf("bad legacy record: %s", data)
	}
	if got, err := TokenFromKeychain(site); err != nil || got != token {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := TokenFromKeychain(Site{URL: "https://other.example"}); err == nil || !strings.Contains(err.Error(), "Not signed in") {
		t.Fatalf("got %v", err)
	}
}

func TestGetSiteDropsDefaultPort(t *testing.T) {
	t.Setenv("PLAN_MANAGER_URL", "https://Example.com:443")
	if site, err := GetSite(); err != nil || site.URL != "https://example.com" {
		t.Fatalf("got %v %v", site, err)
	}
}

func TestGetSiteAllowsHTTPOnlyForLoopback(t *testing.T) {
	for value, want := range map[string]string{
		"http://localhost:5173":  "http://localhost:5173",
		"http://127.0.0.1:5173/": "http://127.0.0.1:5173",
		"http://[::1]:5173":      "http://[::1]:5173",
		"http://LOCALHOST:80":    "http://localhost",
	} {
		t.Setenv("PLAN_MANAGER_URL", value)
		if site, err := GetSite(); err != nil || site.URL != want {
			t.Errorf("%s: got %v %v, want %s", value, site, err, want)
		}
	}
	for _, value := range []string{"http://192.168.1.10:5173", "http://localhost.evil.example", "http://127.0.0.1.nip.io", "http://localhost:5173/path"} {
		t.Setenv("PLAN_MANAGER_URL", value)
		if _, err := GetSite(); err == nil {
			t.Errorf("%s should be rejected", value)
		}
	}
}

func TestPushSendsRevisionOfThePushedMarkdown(t *testing.T) {
	var sent PushPayload
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(data, &sent); err != nil {
			t.Errorf("payload is not JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"version":1,"plan":{"revision":"` + sent.Revision + `"},"url":"/plans/plan-1"}`))
	}))
	defer srv.Close()
	previousClient := httpClient
	httpClient = srv.Client()
	t.Cleanup(func() { httpClient = previousClient })

	raw := "---\r\nid: plan-1\r\ntitle: CRLF plan\r\n---\r\n\r\n# Body\r\nline\r\n"
	stale := strings.Repeat("0", 64)
	result, err := Push(Site{URL: srv.URL}, "pm_example_secret", PushPayload{ID: "plan-1", Markdown: raw, Revision: stale})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sent.Markdown, "\r\n") {
		t.Fatalf("pushed Markdown still has CRLF: %q", sent.Markdown)
	}
	sum := sha256.Sum256([]byte(sent.Markdown))
	if want := hex.EncodeToString(sum[:]); sent.Revision != want || result.Revision != want {
		t.Fatalf("revision %q (result %q) is not sha256 of the pushed Markdown %q", sent.Revision, result.Revision, want)
	}
	lf := strings.ReplaceAll(raw, "\r\n", "\n")
	if sent.Markdown != lf {
		t.Fatalf("pushed Markdown = %q, want %q", sent.Markdown, lf)
	}
}
