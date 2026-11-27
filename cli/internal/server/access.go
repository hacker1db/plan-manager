package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Dashboard access control.
//
// The dashboard listens on 127.0.0.1, which every local account and process can
// reach, so the loopback address alone is not authentication. Each user has an
// access token in a 0600 file that the server never sends over HTTP. Clients
// prove they can read that file in one of two ways:
//
//   - CLI clients send it as "Authorization: Bearer <token>".
//   - `plan open` uses the bearer token to get a short-lived, single-use ticket
//     and opens /_auth?ticket=..., which sets an HttpOnly, SameSite=Strict cookie.
//     The browser URL (visible in the process list) never carries the token.
//
// /_session, /api/t3/projects, and every mutation require that access; mutations
// also still require the per-process CSRF token from /_session.

const (
	accessCookie     = "plan_access"
	ticketTTL        = 60 * time.Second
	maxActiveTickets = 16
	tokenFileName    = "dashboard-token"
)

// TokenPath is the access-token file inside the CLI configuration directory.
func TokenPath(configDir string) string { return filepath.Join(configDir, tokenFileName) }

// LoadOrCreateAccessToken returns the token in path, creating the file (0600,
// in a 0700 directory) when it does not exist. It refuses a token file that
// other users can read or write, or that is not a regular file.
func LoadOrCreateAccessToken(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if token, err := readAccessToken(path); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return token, err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		// Another process created it first; use theirs.
		return readAccessToken(path)
	}
	if err != nil {
		return "", err
	}
	if _, err := f.WriteString(token + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return token, nil
}

func readAccessToken(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("dashboard token %s is not a regular file", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("dashboard token %s is accessible to other users (mode %#o); run chmod 600 on it", path, info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 32 {
		return "", fmt.Errorf("dashboard token %s is too short", path)
	}
	return token, nil
}

// cookieValue is derived from the token, so a browser stays signed in across
// server restarts while the token file is unchanged.
func (s *Server) cookieValue() string {
	mac := hmac.New(sha256.New, []byte(s.accessToken))
	mac.Write([]byte("plan-manager-dashboard-cookie-v1"))
	return hex.EncodeToString(mac.Sum(nil))
}

func equalSecret(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// hasAccess reports whether the request carries the bearer token or the cookie.
func (s *Server) hasAccess(r *http.Request) bool {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return equalSecret(strings.TrimPrefix(auth, "Bearer "), s.accessToken)
	}
	if c, err := r.Cookie(accessCookie); err == nil {
		return equalSecret(c.Value, s.cookieValue())
	}
	return false
}

func (s *Server) requireAccess(w http.ResponseWriter, r *http.Request) bool {
	if s.hasAccess(r) {
		return true
	}
	writeError(w, 401, "dashboard sign-in required: run `plan open` to open the dashboard")
	return false
}

// issueTicket returns a single-use ticket for /_auth. Bearer access only.
func (s *Server) issueTicket(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || !equalSecret(strings.TrimPrefix(auth, "Bearer "), s.accessToken) {
		writeError(w, 401, "bearer token required")
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeError(w, 500, "internal server error")
		return
	}
	ticket := hex.EncodeToString(raw)
	now := time.Now()
	s.ticketMu.Lock()
	for t, exp := range s.tickets {
		if now.After(exp) {
			delete(s.tickets, t)
		}
	}
	if len(s.tickets) >= maxActiveTickets {
		s.ticketMu.Unlock()
		writeError(w, 429, "too many pending sign-in tickets")
		return
	}
	s.tickets[ticket] = now.Add(ticketTTL)
	s.ticketMu.Unlock()
	writeJSON(w, 200, map[string]any{"ticket": ticket, "expiresIn": int(ticketTTL / time.Second)})
}

func (s *Server) redeemTicket(ticket string) bool {
	if ticket == "" {
		return false
	}
	s.ticketMu.Lock()
	defer s.ticketMu.Unlock()
	for t, exp := range s.tickets {
		if equalSecret(ticket, t) {
			delete(s.tickets, t)
			return time.Now().Before(exp)
		}
	}
	return false
}

// safeNext keeps the post-sign-in redirect on this dashboard.
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.ContainsAny(next, "\\\r\n") {
		return "/"
	}
	return next
}

// serveAuth exchanges a ticket for the access cookie and redirects to next.
func (s *Server) serveAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	if !s.redeemTicket(q.Get("ticket")) {
		writeError(w, 401, "sign-in link is invalid or expired: run `plan open` again")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: accessCookie, Value: s.cookieValue(), Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
		MaxAge: int((400 * 24 * time.Hour) / time.Second),
	})
	http.Redirect(w, r, safeNext(q.Get("next")), http.StatusSeeOther)
}

// SignInURL asks the dashboard on port for a ticket and returns the URL that
// signs the browser in and then shows next (a path such as "/plans/id").
func SignInURL(dashboardURL string, port int, token, next string) (string, error) {
	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/_ticket", nil)
	if err != nil {
		return "", err
	}
	req.Host = "plans.localhost:" + strconv.Itoa(port)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		Ticket string `json:"ticket"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&body); err != nil {
		return "", err
	}
	if res.StatusCode != 200 || body.Ticket == "" {
		if body.Error == "" {
			body.Error = res.Status
		}
		return "", fmt.Errorf("dashboard refused sign-in: %s", body.Error)
	}
	return strings.TrimRight(dashboardURL, "/") + "/_auth?ticket=" + body.Ticket + "&next=" + url.QueryEscape(safeNext(next)), nil
}
