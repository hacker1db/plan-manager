// Package remote signs in to the hosted Plan Manager site and pushes plans.
package remote

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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

func rejectRedirect(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }

var httpClient = &http.Client{Timeout: 30 * time.Second, CheckRedirect: rejectRedirect}

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
	bad := errors.New("PLAN_MANAGER_URL must be a bare https URL, or http://localhost for local testing")
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return Site{}, bad
	}
	host := strings.ToLower(u.Host)
	switch {
	case u.Scheme == "https":
		return Site{URL: "https://" + strings.TrimSuffix(host, ":443")}, nil
	// Plain http is allowed only for loopback, where traffic never leaves the machine.
	case u.Scheme == "http" && isLoopbackHost(u.Hostname()):
		return Site{URL: "http://" + strings.TrimSuffix(host, ":80")}, nil
	}
	return Site{}, bad
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
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

// siteKeychainService namespaces Keychain records by normalized site origin so
// a credential issued for one site is never looked up for another. The format
// ("plan-manager:site:<origin>") is shared with the TypeScript CLI.
func siteKeychainService(site Site) string { return keychainService + ":" + site.URL }

var errUnboundCredential = errors.New(`Stored credential is not bound to this site. Run "plan auth login" to sign in again.`)

func credentialFromKeychain(site Site) (string, error) {
	out, err := exec.Command(securityCommand(), "find-generic-password", "-a", "plan-manager", "-s", siteKeychainService(site), "-w").Output()
	if err != nil {
		// A record under the old, unnamespaced service is not bound to any site.
		if legacy, lerr := exec.Command(securityCommand(), "find-generic-password", "-a", "plan-manager", "-s", keychainService, "-w").Output(); lerr == nil && strings.TrimSpace(string(legacy)) != "" && !strings.Contains(string(legacy), `"siteUrl"`) {
			return "", errUnboundCredential
		}
		return "", errors.New(`Not signed in. Run "plan auth login".`)
	}
	return strings.TrimSpace(string(out)), nil
}

func storeCredential(site Site, value string) error {
	var stderr bytes.Buffer
	c := exec.Command(securityCommand(), "add-generic-password", "-U", "-a", "plan-manager", "-s", siteKeychainService(site), "-w")
	c.Stdin = strings.NewReader(value + "\n")
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("Unable to store credential in macOS Keychain: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}

// storedLegacy wraps a pasted pm_ token with the site it was issued for.
type storedLegacy struct {
	Version  int    `json:"version"`
	Provider string `json:"provider"`
	SiteURL  string `json:"siteUrl"`
	Token    string `json:"token"`
}

// StoreLegacyToken saves a pasted pm_ token bound to site.
func StoreLegacyToken(site Site, token string) error {
	if !legacyToken.MatchString(token) {
		return errors.New(`Token format is invalid. WorkOS login does not use a pasted token; run "plan auth login" instead.`)
	}
	data, _ := json.Marshal(storedLegacy{Version: 2, Provider: "legacy-token", SiteURL: site.URL, Token: token})
	return storeCredential(site, string(data))
}

// RemoveToken deletes the stored credential.
func RemoveToken(site Site) error {
	var stderr bytes.Buffer
	c := exec.Command(securityCommand(), "delete-generic-password", "-a", "plan-manager", "-s", siteKeychainService(site))
	c.Stderr = &stderr
	if err := c.Run(); err != nil && !strings.Contains(strings.ToLower(stderr.String()), "could not be found") {
		return fmt.Errorf("Unable to remove Keychain credential: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}

type storedOAuth struct {
	Version              int    `json:"version"`
	Provider             string `json:"provider"`
	SiteURL              string `json:"siteUrl"`
	AccessToken          string `json:"accessToken"`
	RefreshToken         string `json:"refreshToken"`
	AccessTokenExpiresAt int64  `json:"accessTokenExpiresAt"`
	TokenEndpoint        string `json:"tokenEndpoint"`
	ClientID             string `json:"clientId"`
	IssuerURL            string `json:"issuerUrl"`
	Audience             string `json:"audience"`
	Scope                string `json:"scope"`
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
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", fmt.Errorf("%s must be an HTTPS URL", label)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

// TokenFromKeychain returns a usable bearer token, refreshing an expired
// OAuth access token when needed.
// The credential must be bound to exactly site's origin; nothing is refreshed
// or returned otherwise.
func TokenFromKeychain(site Site) (string, error) {
	value, err := credentialFromKeychain(site)
	if err != nil {
		return "", err
	}
	if legacyToken.MatchString(value) {
		return "", errUnboundCredential
	}
	var header struct {
		Version  int    `json:"version"`
		Provider string `json:"provider"`
		SiteURL  string `json:"siteUrl"`
	}
	if json.Unmarshal([]byte(value), &header) == nil && header.Version == 1 {
		return "", errors.New(`Stored Clerk credential is obsolete. Run "plan auth login" to sign in with WorkOS.`)
	}
	if header.SiteURL != site.URL {
		return "", errUnboundCredential
	}
	if header.Provider == "legacy-token" {
		var legacy storedLegacy
		if json.Unmarshal([]byte(value), &legacy) != nil || legacy.Version != 2 || !legacyToken.MatchString(legacy.Token) {
			return "", errors.New(`Stored credential has an invalid format. Run "plan auth login" to sign in again.`)
		}
		return legacy.Token, nil
	}
	var cred storedOAuth
	if json.Unmarshal([]byte(value), &cred) != nil || cred.Version != 2 || cred.Provider != "workos-cli" || cred.AccessToken == "" || cred.RefreshToken == "" || cred.TokenEndpoint == "" || cred.ClientID == "" || cred.IssuerURL == "" || cred.Audience == "" || cred.Scope != "plans:write" {
		return "", errors.New(`Stored credential has an invalid format. Run "plan auth login" to sign in again.`)
	}
	if cred.AccessTokenExpiresAt <= nowMillis()+30_000 {
		var tok tokenResponse
		form := url.Values{"client_id": {cred.ClientID}, "grant_type": {"refresh_token"}, "refresh_token": {cred.RefreshToken}}
		if err := postForm(cred.TokenEndpoint, "WorkOS token refresh", form, &tok); err != nil {
			return "", err
		}
		if tok.AccessToken == "" || tok.RefreshToken == "" || !strings.EqualFold(tok.TokenType, "bearer") || tok.ExpiresIn == nil || *tok.ExpiresIn <= 0 {
			return "", errors.New("WorkOS returned an invalid refreshed token pair; sign in again")
		}
		cred.AccessToken = tok.AccessToken
		cred.RefreshToken = tok.RefreshToken
		cred.AccessTokenExpiresAt = nowMillis() + int64(*tok.ExpiresIn*1000)
		data, _ := json.Marshal(cred)
		if err := storeCredential(site, string(data)); err != nil {
			return "", err
		}
	}
	return cred.AccessToken, nil
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

type oauthConfig struct {
	Version                     int    `json:"version"`
	ClientID                    string `json:"clientId"`
	IssuerURL                   string `json:"issuerUrl"`
	Audience                    string `json:"audience"`
	Scope                       string `json:"scope"`
	DeviceAuthorizationEndpoint string `json:"deviceAuthorizationEndpoint"`
	TokenEndpoint               string `json:"tokenEndpoint"`
	JWKSURL                     string `json:"jwksUrl"`
}

type deviceAuthorization struct {
	DeviceCode              string   `json:"device_code"`
	UserCode                string   `json:"user_code"`
	VerificationURI         string   `json:"verification_uri"`
	VerificationURIComplete string   `json:"verification_uri_complete"`
	ExpiresIn               *float64 `json:"expires_in"`
	Interval                *float64 `json:"interval"`
}

var pollWait = time.Sleep

func endpointMatches(value, origin, path, label string) (string, error) {
	endpoint, err := httpsEndpoint(value, label)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(endpoint)
	if u.Scheme+"://"+u.Host != origin || u.Path != path {
		return "", errors.New("Plan Manager returned cross-origin or nonstandard WorkOS CLI endpoints")
	}
	return endpoint, nil
}

func oauthConfiguration(site Site) (oauthConfig, error) {
	var cfg oauthConfig
	if err := getJSON(site.URL+"/api/v1", "Plan Manager auth configuration", &cfg); err != nil {
		return cfg, err
	}
	if cfg.Version != 2 || cfg.ClientID == "" || cfg.Audience == "" || cfg.Scope != "plans:write" {
		return cfg, errors.New("Plan Manager returned an invalid WorkOS CLI configuration")
	}
	issuer, err := httpsEndpoint(cfg.IssuerURL, "WorkOS issuer")
	if err != nil {
		return cfg, err
	}
	issuerURL, _ := url.Parse(issuer)
	if issuerURL.Path != "" && issuerURL.Path != "/" {
		return cfg, errors.New("Plan Manager returned cross-origin or nonstandard WorkOS CLI endpoints")
	}
	origin := issuerURL.Scheme + "://" + issuerURL.Host
	if cfg.DeviceAuthorizationEndpoint, err = endpointMatches(cfg.DeviceAuthorizationEndpoint, origin, "/oauth2/device_authorization", "Device authorization endpoint"); err != nil {
		return cfg, err
	}
	if cfg.TokenEndpoint, err = endpointMatches(cfg.TokenEndpoint, origin, "/oauth2/token", "Token endpoint"); err != nil {
		return cfg, err
	}
	if cfg.JWKSURL, err = endpointMatches(cfg.JWKSURL, origin, "/oauth2/jwks", "JWKS endpoint"); err != nil {
		return cfg, err
	}
	cfg.IssuerURL = issuer
	return cfg, nil
}

func postFormStatus(u string, form url.Values, v any) (int, error) {
	req, _ := http.NewRequest(http.MethodPost, u, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return res.StatusCode, errors.New("WorkOS returned an invalid JSON response")
	}
	return res.StatusCode, nil
}

// Login runs the WorkOS Connect CLI device flow and stores the resulting
// credential in macOS Keychain.
func Login(site Site, out io.Writer) error {
	cfg, err := oauthConfiguration(site)
	if err != nil {
		return err
	}
	var authorization deviceAuthorization
	form := url.Values{"client_id": {cfg.ClientID}, "scope": {"openid offline_access " + cfg.Scope}}
	if err := postForm(cfg.DeviceAuthorizationEndpoint, "WorkOS device authorization", form, &authorization); err != nil {
		return err
	}
	if authorization.DeviceCode == "" || authorization.UserCode == "" || authorization.VerificationURI == "" || authorization.ExpiresIn == nil || *authorization.ExpiresIn <= 0 {
		return errors.New("WorkOS returned an invalid device authorization response")
	}
	verification := authorization.VerificationURIComplete
	if verification == "" {
		verification = authorization.VerificationURI
	}
	verification, err = httpsEndpoint(verification, "Verification URI")
	if err != nil {
		return err
	}
	verificationURL, _ := url.Parse(verification)
	issuerURL, _ := url.Parse(cfg.IssuerURL)
	if verificationURL.Scheme+"://"+verificationURL.Host != issuerURL.Scheme+"://"+issuerURL.Host {
		return errors.New("WorkOS returned a cross-origin verification URI")
	}
	fmt.Fprintf(out, "Sign in to Plan Manager\nCode: %s\nOpen: %s\nWaiting for approval...\n", authorization.UserCode, verification)
	openBrowser(verification, os.Stdout)

	deadline := time.Now().Add(time.Duration(*authorization.ExpiresIn * float64(time.Second)))
	interval := 5 * time.Second
	if authorization.Interval != nil {
		interval = time.Duration(*authorization.Interval * float64(time.Second))
	}
	if interval < time.Second {
		interval = time.Second
	}
	if interval > 60*time.Second {
		interval = 60 * time.Second
	}
	var tok tokenResponse
	for time.Now().Before(deadline) {
		status, pollErr := postFormStatus(cfg.TokenEndpoint, url.Values{
			"client_id": {cfg.ClientID}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {authorization.DeviceCode},
		}, &tok)
		if pollErr != nil {
			return pollErr
		}
		if status >= 200 && status <= 299 {
			break
		}
		switch tok.Error {
		case "authorization_pending":
			pollWait(interval)
		case "slow_down":
			interval += 5 * time.Second
			if interval > 60*time.Second {
				interval = 60 * time.Second
			}
			pollWait(interval)
		default:
			if tok.ErrorDescription != "" {
				return errors.New(tok.ErrorDescription)
			}
			if tok.Error != "" {
				return errors.New(tok.Error)
			}
			return fmt.Errorf("WorkOS device authorization failed (%d)", status)
		}
		tok = tokenResponse{}
	}
	if tok.AccessToken == "" || tok.RefreshToken == "" || !strings.EqualFold(tok.TokenType, "bearer") || tok.ExpiresIn == nil || *tok.ExpiresIn <= 0 {
		if !time.Now().Before(deadline) {
			return errors.New("WorkOS device authorization expired. Run plan auth login again.")
		}
		return errors.New("WorkOS returned an invalid token response")
	}
	cred := storedOAuth{Version: 2, Provider: "workos-cli", SiteURL: site.URL, AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken,
		AccessTokenExpiresAt: nowMillis() + int64(*tok.ExpiresIn*1000), TokenEndpoint: cfg.TokenEndpoint, ClientID: cfg.ClientID,
		IssuerURL: cfg.IssuerURL, Audience: cfg.Audience, Scope: cfg.Scope}
	data, _ := json.Marshal(cred)
	if err := storeCredential(site, string(data)); err != nil {
		return err
	}
	fmt.Fprintf(out, "Signed in to %s and stored the WorkOS credential in macOS Keychain.\n", site.URL)
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

// Normalized returns the payload the server will accept: Markdown with CRLF line endings
// converted to LF (the server stores exactly that) and Revision set to the SHA-256 of those
// bytes. The server recomputes the revision and rejects a mismatch.
func (p PushPayload) Normalized() PushPayload {
	p.Markdown = strings.ReplaceAll(p.Markdown, "\r\n", "\n")
	sum := sha256.Sum256([]byte(p.Markdown))
	p.Revision = hex.EncodeToString(sum[:])
	return p
}

// Push uploads one plan version.
func Push(site Site, token string, p PushPayload) (PushResult, error) {
	p = p.Normalized()
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
