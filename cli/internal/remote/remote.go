// Package remote signs in to the hosted Plan Manager site and pushes plans.
package remote

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/config"
)

const (
	DefaultSiteURL  = "https://planmanager.hacker1db.dev"
	keychainService = "plan-manager:site"
)

var legacyToken = regexp.MustCompile(`^pm_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{32,128}$`)

var httpClient = &http.Client{Timeout: 30 * time.Second}

type Site struct{ URL string }

func configDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(config.HomeDir(), ".config")
	}
	return filepath.Join(base, "plan-manager")
}

func configPath() string { return filepath.Join(configDir(), "site.json") }

func securityCommand() string {
	if v := os.Getenv("PLAN_MANAGER_SECURITY_COMMAND"); v != "" {
		return v
	}
	return "/usr/bin/security"
}

// GetSite returns the hosted site, honoring PLAN_MANAGER_URL.
func GetSite() (Site, error) {
	raw := strings.TrimSpace(os.Getenv("PLAN_MANAGER_URL"))
	if raw == "" {
		raw = DefaultSiteURL
	}
	u, err := url.Parse(raw)
	bad := errors.New("PLAN_MANAGER_URL must be a bare https URL")
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return Site{}, bad
	}
	return Site{URL: "https://" + strings.ToLower(u.Host)}, nil
}

// SiteConfig records the last pushed revision per plan ID.
type SiteConfig struct {
	Version   int               `json:"version"`
	Revisions map[string]string `json:"revisions"`
}

func readJSON(path string, v any) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err == nil {
		err = json.Unmarshal(data, v)
	}
	if err != nil {
		return false, fmt.Errorf("Unable to read %s: %s", path, err)
	}
	return true, nil
}

func LoadConfig(site Site) (*SiteConfig, error) {
	var raw struct {
		Version   int            `json:"version"`
		Revisions map[string]any `json:"revisions"`
	}
	found, err := readJSON(configPath(), &raw)
	if err != nil {
		return nil, err
	}
	cfg := &SiteConfig{Version: 1, Revisions: map[string]string{}}
	if found {
		if raw.Version != 1 {
			return nil, fmt.Errorf("Unable to read %s: unsupported version", configPath())
		}
		for k, v := range raw.Revisions {
			if s, ok := v.(string); ok {
				cfg.Revisions[k] = s
			}
		}
		return cfg, nil
	}
	// Carry push revisions over from the multi-remote config so conflict detection keeps working.
	var legacy struct {
		Remotes []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"remotes"`
		Revisions map[string]map[string]any `json:"revisions"`
	}
	if ok, err := readJSON(filepath.Join(configDir(), "remotes.json"), &legacy); ok && err == nil {
		for _, r := range legacy.Remotes {
			if r.URL == site.URL && r.Name != "" {
				for k, v := range legacy.Revisions[r.Name] {
					if s, ok := v.(string); ok {
						cfg.Revisions[k] = s
					}
				}
				break
			}
		}
	}
	return cfg, nil
}

func SaveConfig(cfg *SiteConfig) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath(), append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(configPath(), 0o600)
}

func credentialFromKeychain() (string, error) {
	out, err := exec.Command(securityCommand(), "find-generic-password", "-a", "plan-manager", "-s", keychainService, "-w").Output()
	if err != nil {
		return "", errors.New(`Not signed in. Run "plan auth login".`)
	}
	return strings.TrimSpace(string(out)), nil
}

func storeCredential(value string) error {
	var stderr bytes.Buffer
	// A trailing -w makes `security` prompt for the password on stdin (twice:
	// enter + retype), keeping the secret out of the process argument list,
	// where any same-user process could read it.
	c := exec.Command(securityCommand(), "add-generic-password", "-U", "-a", "plan-manager", "-s", keychainService, "-w")
	c.Stdin = strings.NewReader(value + "\n" + value + "\n")
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("Unable to store credential in macOS Keychain: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}

// StoreLegacyToken saves a pasted pm_ token.
func StoreLegacyToken(token string) error {
	if !legacyToken.MatchString(token) {
		return errors.New(`Token format is invalid. Clerk login no longer needs a pasted token; run "plan auth login" instead.`)
	}
	return storeCredential(token)
}

// RemoveToken deletes the stored credential.
func RemoveToken() error {
	var stderr bytes.Buffer
	c := exec.Command(securityCommand(), "delete-generic-password", "-a", "plan-manager", "-s", keychainService)
	c.Stderr = &stderr
	if err := c.Run(); err != nil && !strings.Contains(strings.ToLower(stderr.String()), "could not be found") {
		return fmt.Errorf("Unable to remove Keychain credential: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}

type storedOAuth struct {
	Version              int    `json:"version"`
	AccessToken          string `json:"accessToken"`
	RefreshToken         string `json:"refreshToken"`
	AccessTokenExpiresAt int64  `json:"accessTokenExpiresAt"`
	TokenEndpoint        string `json:"tokenEndpoint"`
	ClientID             string `json:"clientId"`
}

type tokenResponse struct {
	AccessToken      string   `json:"access_token"`
	RefreshToken     string   `json:"refresh_token"`
	TokenType        string   `json:"token_type"`
	ExpiresIn        *float64 `json:"expires_in"`
	Error            string   `json:"error"`
	ErrorDescription string   `json:"error_description"`
}

func nowMillis() int64 { return time.Now().UnixMilli() }

func decodeResponse(res *http.Response, label string, v any) error {
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	_ = json.Unmarshal(data, v)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e tokenResponse
		_ = json.Unmarshal(data, &e)
		if e.ErrorDescription != "" {
			return errors.New(e.ErrorDescription)
		}
		if e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("%s failed (%d)", label, res.StatusCode)
	}
	return nil
}

func getJSON(u, label string, v any) error {
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Accept", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	return decodeResponse(res, label, v)
}

func postForm(u, label string, form url.Values, v any) error {
	req, _ := http.NewRequest(http.MethodPost, u, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	return decodeResponse(res, label, v)
}

func httpsEndpoint(value, label string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return "", fmt.Errorf("%s must be an HTTPS URL", label)
	}
	return u.String(), nil
}

// TokenFromKeychain returns a usable bearer token, refreshing an expired
// OAuth access token when needed.
func TokenFromKeychain() (string, error) {
	value, err := credentialFromKeychain()
	if err != nil {
		return "", err
	}
	if legacyToken.MatchString(value) {
		return value, nil
	}
	var cred storedOAuth
	if json.Unmarshal([]byte(value), &cred) != nil || cred.Version != 1 || cred.AccessToken == "" || cred.TokenEndpoint == "" || cred.ClientID == "" {
		return "", errors.New(`Stored credential has an invalid format. Run "plan auth login" to sign in again.`)
	}
	if cred.AccessTokenExpiresAt <= nowMillis()+30_000 {
		var tok tokenResponse
		form := url.Values{"client_id": {cred.ClientID}, "grant_type": {"refresh_token"}, "refresh_token": {cred.RefreshToken}}
		if err := postForm(cred.TokenEndpoint, "Clerk token refresh", form, &tok); err != nil {
			return "", err
		}
		if tok.AccessToken == "" || tok.ExpiresIn == nil {
			return "", errors.New("Clerk returned an invalid refreshed token")
		}
		cred.AccessToken = tok.AccessToken
		if tok.RefreshToken != "" {
			cred.RefreshToken = tok.RefreshToken
		}
		cred.AccessTokenExpiresAt = nowMillis() + int64(*tok.ExpiresIn*1000)
		data, _ := json.Marshal(cred)
		if err := storeCredential(string(data)); err != nil {
			return "", err
		}
	}
	return cred.AccessToken, nil
}

func randomURLString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func openBrowser(u string, out *os.File) {
	if fi, err := out.Stat(); err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return
	}
	var name string
	switch runtime.GOOS {
	case "darwin":
		name = "open"
	case "linux":
		name = "xdg-open"
	default:
		return
	}
	c := exec.Command(name, u)
	if c.Start() == nil {
		go c.Wait()
	}
}

const page = "<p>%s</p>"

// Login runs the Clerk Authorization Code + PKCE flow through a loopback
// callback server and stores the resulting credential in the Keychain.
func Login(site Site, out io.Writer) error {
	var cfg struct {
		ClientID  string `json:"clientId"`
		IssuerURL string `json:"issuerUrl"`
	}
	if err := getJSON(site.URL+"/api/v1", "Plan Manager auth configuration", &cfg); err != nil {
		return err
	}
	if cfg.ClientID == "" || cfg.IssuerURL == "" {
		return errors.New("Plan Manager returned an invalid OAuth configuration")
	}
	issuer, err := httpsEndpoint(cfg.IssuerURL, "Clerk issuer")
	if err != nil {
		return err
	}
	issuerURL, _ := url.Parse(issuer)
	metaURL := issuerURL.ResolveReference(&url.URL{Path: "/.well-known/oauth-authorization-server"})
	var meta struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}
	if err := getJSON(metaURL.String(), "Clerk OAuth metadata", &meta); err != nil {
		return err
	}
	if meta.AuthorizationEndpoint == "" || meta.TokenEndpoint == "" {
		return errors.New("This Clerk instance does not advertise Authorization Code with PKCE. Enable it for the Plan Manager CLI application in Clerk.")
	}
	authEndpoint, err := httpsEndpoint(meta.AuthorizationEndpoint, "Authorization endpoint")
	if err != nil {
		return err
	}
	tokenEndpoint, err := httpsEndpoint(meta.TokenEndpoint, "Token endpoint")
	if err != nil {
		return err
	}

	state := randomURLString(32)
	verifier := randomURLString(48)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return errors.New("Unable to start the local OAuth callback server")
	}
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)
	type result struct {
		code string
		err  error
	}
	results := make(chan result, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		received := q.Get("state")
		switch {
		case received == "" || subtle.ConstantTimeCompare([]byte(received), []byte(state)) != 1:
			w.WriteHeader(400)
			fmt.Fprintf(w, page, "Plan Manager sign-in could not be verified. Return to the sign-in page and try again.")
		case q.Get("error") != "":
			w.WriteHeader(400)
			fmt.Fprintf(w, page, "Plan Manager sign-in was cancelled. You may close this window.")
			select {
			case results <- result{err: fmt.Errorf("Clerk authorization failed: %s", q.Get("error"))}:
			default:
			}
		case q.Get("code") == "":
			w.WriteHeader(400)
			fmt.Fprintf(w, page, "Plan Manager sign-in failed. Return to the sign-in page and try again.")
		default:
			fmt.Fprintf(w, page, "Plan Manager sign-in complete. You may close this window.")
			select {
			case results <- result{code: q.Get("code")}:
			default:
			}
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	authURL, _ := url.Parse(authEndpoint)
	authURL.RawQuery = url.Values{
		"response_type": {"code"}, "client_id": {cfg.ClientID}, "redirect_uri": {redirectURI},
		"scope": {"openid offline_access"}, "state": {state},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"},
	}.Encode()
	fmt.Fprintf(out, "Sign in to Plan Manager\nOpen: %s\nWaiting for approval...\n", authURL)
	openBrowser(authURL.String(), os.Stdout)

	var code string
	select {
	case r := <-results:
		if r.err != nil {
			return r.err
		}
		code = r.code
	case <-time.After(5 * time.Minute):
		return errors.New("Sign-in timed out. Run plan auth login again to start a new sign-in.")
	}

	var tok tokenResponse
	form := url.Values{"client_id": {cfg.ClientID}, "grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI}, "code_verifier": {verifier}}
	if err := postForm(tokenEndpoint, "Clerk authorization code exchange", form, &tok); err != nil {
		return err
	}
	if tok.AccessToken == "" || tok.RefreshToken == "" || !strings.EqualFold(tok.TokenType, "bearer") || tok.ExpiresIn == nil {
		return errors.New("Clerk returned an invalid token response")
	}
	cred := storedOAuth{Version: 1, AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken,
		AccessTokenExpiresAt: nowMillis() + int64(*tok.ExpiresIn*1000), TokenEndpoint: tokenEndpoint, ClientID: cfg.ClientID}
	data, _ := json.Marshal(cred)
	if err := storeCredential(string(data)); err != nil {
		return err
	}
	fmt.Fprintf(out, "Signed in to %s and stored the Clerk credential in macOS Keychain.\n", site.URL)
	return nil
}

// PushPayload is the body of PUT /api/v1/plans/{id}/versions.
type PushPayload struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	Status           string   `json:"status"`
	Tags             []string `json:"tags"`
	Created          string   `json:"created"`
	Updated          string   `json:"updated"`
	Markdown         string   `json:"markdown"`
	Revision         string   `json:"revision"`
	ExpectedRevision *string  `json:"expectedRevision"`
}

type PushResult struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Revision string `json:"revision"`
}

// ErrConflict marks a push rejected because the hosted copy changed.
var ErrConflict = errors.New("revision conflict")

// Push uploads one plan version.
func Push(site Site, token string, p PushPayload) (PushResult, error) {
	body, _ := json.Marshal(p)
	req, _ := http.NewRequest(http.MethodPut, site.URL+"/api/v1/plans/"+url.PathEscape(p.ID)+"/versions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return PushResult{}, err
	}
	defer res.Body.Close()
	var rb struct {
		Error           string `json:"error"`
		CurrentRevision string `json:"currentRevision"`
		URL             string `json:"url"`
		Plan            struct {
			Revision string `json:"revision"`
		} `json:"plan"`
	}
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	_ = json.Unmarshal(data, &rb)
	if res.StatusCode == http.StatusConflict {
		cur := rb.CurrentRevision
		if cur == "" {
			cur = "an unknown revision"
		}
		return PushResult{}, fmt.Errorf("Revision conflict for %s; site is at %s: %w", p.ID, cur, ErrConflict)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		msg := rb.Error
		if msg == "" {
			msg = "unexpected response"
		}
		return PushResult{}, fmt.Errorf("Push failed (%d): %s", res.StatusCode, msg)
	}
	ref := rb.URL
	if ref == "" {
		ref = "/plans/" + p.ID
	}
	base, _ := url.Parse(site.URL)
	target, err := url.Parse(ref)
	if err != nil {
		target = &url.URL{Path: "/plans/" + p.ID}
	}
	rev := rb.Plan.Revision
	if rev == "" {
		rev = p.Revision
	}
	return PushResult{ID: p.ID, URL: base.ResolveReference(target).String(), Revision: rev}, nil
}
