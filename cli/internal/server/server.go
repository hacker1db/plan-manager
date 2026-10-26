// Package server is the local dashboard: a 127.0.0.1-only HTTP server that
// serves the plan library, live-reload events, and a small mutation API.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/lock"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
)

//go:generate sh -c "rm -rf dashboard && cp -R ../../../src/dashboard dashboard"

//go:embed dashboard
var dashboardFS embed.FS

const (
	maxBodyBytes      = 64 * 1024
	stabilityDelay    = 120 * time.Millisecond
	watchDebounce     = 300 * time.Millisecond
	reconcileInterval = 5 * time.Second
	heartbeatInterval = 15 * time.Second
)

var (
	allowedHostnames = map[string]bool{"plans.localhost": true, "127.0.0.1": true, "localhost": true}
	validID          = regexp.MustCompile(`^[A-Za-z0-9_-]{4,128}$`)
	revisionPattern  = regexp.MustCompile(`(?i)^[a-f0-9]{64}$`)
	detailRoute      = regexp.MustCompile(`^/api/plans/([^/]+)$`)
	actionRoute      = regexp.MustCompile(`^/api/plans/([^/]+)/(status|archive|copy-path|open-in-editor)$`)
	taskRoute        = regexp.MustCompile(`^/api/plans/([^/]+)/tasks/(\d+)$`)
	planPageRoute    = regexp.MustCompile(`^/plans/[^/]+$`)
)

type Options struct {
	Port     int
	Host     string
	PlanHome string
	// NoWatch disables filesystem notifications (reconciliation still runs).
	NoWatch bool
	// Zero values use the defaults.
	WatchDebounce, StabilityDelay, ReconcileInterval time.Duration
}

type Server struct {
	URL  string
	Port int

	home, archive string
	host          string
	csrf          string
	httpServer    *http.Server
	watcher       *fsnotify.Watcher

	mu       sync.Mutex
	clients  map[chan string]struct{}
	sequence int
	snapshot snapshot
	debounce *time.Timer
	closed   bool
	scanMu   sync.Mutex
	stop     chan struct{}

	watchDebounce, stabilityDelay, reconcileInterval time.Duration

	pandocOnce sync.Once
	pandocOK   bool
}

type record struct {
	path, revision, id string
}

type snapshot struct {
	fingerprint string
	records     []record
}

type strictPlan struct {
	plans.Meta
	body       string
	content    string
	filePath   string
	revision   string
	isArchived bool
}

// Start listens on host:port and begins watching the plan home.
func Start(opts Options) (*Server, error) {
	if opts.Host != "127.0.0.1" {
		return nil, exitcode.New(exitcode.InvalidInput, "Plan server must bind to 127.0.0.1")
	}
	home, err := filepath.Abs(opts.PlanHome)
	if err != nil {
		return nil, err
	}
	s := &Server{
		home: home, archive: filepath.Join(home, "archive"), host: opts.Host,
		clients: map[chan string]struct{}{}, stop: make(chan struct{}),
		watchDebounce: or(opts.WatchDebounce, watchDebounce), stabilityDelay: or(opts.StabilityDelay, stabilityDelay),
		reconcileInterval: or(opts.ReconcileInterval, reconcileInterval),
	}
	for _, d := range []string{s.home, s.archive} {
		if err := ensureDirectory(d); err != nil {
			return nil, err
		}
	}
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	s.csrf = hex.EncodeToString(token)
	s.snapshot = s.captureSnapshot()

	ln, err := net.Listen("tcp", net.JoinHostPort(opts.Host, strconv.Itoa(opts.Port)))
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return nil, exitcode.New(exitcode.PortCollision, "port %d is already in use. Run \"plan doctor\" for details.", opts.Port)
		}
		return nil, err
	}
	s.Port = ln.Addr().(*net.TCPAddr).Port
	s.URL = "http://plans.localhost:" + strconv.Itoa(s.Port)
	s.httpServer = &http.Server{Handler: http.HandlerFunc(s.handle), ReadHeaderTimeout: 10 * time.Second}
	go s.httpServer.Serve(ln)

	if !opts.NoWatch {
		if w, err := fsnotify.NewWatcher(); err == nil {
			_ = w.Add(s.home)
			_ = w.Add(s.archive)
			s.watcher = w
			go func() {
				for {
					select {
					case _, ok := <-w.Events:
						if !ok {
							return
						}
						s.scheduleScan()
					case _, ok := <-w.Errors:
						if !ok {
							return
						}
					}
				}
			}()
		}
	}
	go s.loop()
	return s, nil
}

func or(v, def time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return def
}

func (s *Server) loop() {
	reconcile := time.NewTicker(s.reconcileInterval)
	heartbeat := time.NewTicker(heartbeatInterval)
	defer reconcile.Stop()
	defer heartbeat.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-reconcile.C:
			s.stableScan()
		case <-heartbeat.C:
			s.broadcast(fmt.Sprintf(": heartbeat %d\n\n", time.Now().UnixMilli()))
		}
	}
}

// Close stops the server and disconnects event clients.
func (s *Server) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if s.debounce != nil {
		s.debounce.Stop()
	}
	for c := range s.clients {
		close(c)
		delete(s.clients, c)
	}
	s.mu.Unlock()
	close(s.stop)
	if s.watcher != nil {
		s.watcher.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.httpServer.Shutdown(ctx)
}

// Reconcile forces a library rescan (used by tests).
func (s *Server) Reconcile() { s.stableScan() }

func ensureDirectory(p string) error {
	info, err := os.Lstat(p)
	if err == nil {
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return exitcode.New(exitcode.StorageUnavailable, "Path exists but is not a directory: %s", p)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.MkdirAll(p, 0o755)
}

func (s *Server) contained(p string) bool { return plans.Inside(s.home, p) }

func (s *Server) planFiles() []string {
	var files []string
	for _, dir := range []string{s.home, s.archive} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || !plans.IsPlanFilename(e.Name()) {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if s.contained(p) {
				files = append(files, p)
			}
		}
	}
	sort.Strings(files)
	return files
}

// validMetadata applies the dashboard's stricter frontmatter rules: every
// field must be present and well-formed rather than defaulted.
func validMetadata(raw plans.Raw) bool {
	id, ok := raw.Str("id")
	if !ok || !validID.MatchString(id) {
		return false
	}
	title, ok := raw.Str("title")
	if !ok || strings.TrimSpace(title) == "" {
		return false
	}
	status, ok := raw.Str("status")
	if !ok || !plans.IsStatus(status) {
		return false
	}
	if _, ok := raw.Str("created"); !ok {
		return false
	}
	if _, ok := raw.Str("updated"); !ok {
		return false
	}
	_, ok = raw.List("tags")
	return ok
}

func (s *Server) readStrict(p string) (*strictPlan, error) {
	if !s.contained(p) {
		return nil, errors.New("path traversal rejected")
	}
	info, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("plan is not a regular file")
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	content := string(data)
	raw, body := plans.ParseFrontmatter(content)
	if !validMetadata(raw) {
		return nil, fmt.Errorf("Malformed plan metadata: %s", filepath.Base(p))
	}
	meta := plans.NormalizeMeta(raw)
	if plans.FormatFromPath(p) == "mdx" {
		meta.Format = "mdx"
	}
	return &strictPlan{
		Meta: meta, body: body, content: content, filePath: p,
		revision: plans.Revision(content), isArchived: filepath.Dir(p) == s.archive,
	}, nil
}

type malformed struct {
	File  string `json:"file"`
	Error string `json:"error"`
}

func (s *Server) index() ([]*strictPlan, []malformed) {
	var list []*strictPlan
	bad := []malformed{}
	for _, f := range s.planFiles() {
		p, err := s.readStrict(f)
		if err != nil {
			bad = append(bad, malformed{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		list = append(list, p)
	}
	return list, bad
}

var errDuplicate = errors.New("duplicate")

func (s *Server) findPlan(id string) (*strictPlan, error) {
	list, _ := s.index()
	var found *strictPlan
	for _, p := range list {
		if p.ID == id {
			if found != nil {
				return nil, fmt.Errorf("Duplicate plan ID: %s: %w", id, errDuplicate)
			}
			found = p
		}
	}
	return found, nil
}

func (s *Server) write(p *strictPlan, meta plans.Meta, body string) (*strictPlan, error) {
	if !s.contained(p.filePath) {
		return nil, errors.New("path traversal rejected")
	}
	meta.Updated = plans.Now()
	content, err := plans.Render(meta, body)
	if err != nil {
		return nil, err
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	tmp := filepath.Join(filepath.Dir(p.filePath), fmt.Sprintf(".%s.%d.%s.tmp", filepath.Base(p.filePath), os.Getpid(), hex.EncodeToString(suffix)))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, err = f.WriteString(content)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, p.filePath)
	}
	if err != nil {
		os.Remove(tmp)
		return nil, err
	}
	return s.readStrict(p.filePath)
}

func (s *Server) captureSnapshot() snapshot {
	var recs []record
	var lines []string
	for _, f := range s.planFiles() {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		content := string(data)
		rev := plans.Revision(content)
		raw, _ := plans.ParseFrontmatter(content)
		id := ""
		if validMetadata(raw) {
			id, _ = raw.Str("id")
		}
		rel := strings.TrimPrefix(f, s.home+string(filepath.Separator))
		recs = append(recs, record{path: rel, revision: rev, id: id})
		lines = append(lines, rel+":"+rev)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return snapshot{fingerprint: hex.EncodeToString(sum[:]), records: recs}
}

func revisionMap(snap snapshot) map[string]string {
	m := map[string]string{}
	for _, r := range snap.records {
		if r.id != "" {
			m[r.id] = r.revision
		}
	}
	return m
}

type change struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
}

func (s *Server) stableScan() {
	if !s.scanMu.TryLock() {
		return
	}
	defer s.scanMu.Unlock()
	if s.isClosed() {
		return
	}
	first := s.captureSnapshot()
	time.Sleep(s.stabilityDelay)
	second := s.captureSnapshot()
	if first.fingerprint != second.fingerprint {
		s.scheduleScan()
		return
	}
	s.mu.Lock()
	prev := s.snapshot
	if second.fingerprint == prev.fingerprint {
		s.mu.Unlock()
		return
	}
	s.snapshot = second
	s.mu.Unlock()
	before, after := revisionMap(prev), revisionMap(second)
	changed := []change{}
	removed := []string{}
	for id, rev := range after {
		if before[id] != rev {
			changed = append(changed, change{id, rev})
		}
	}
	for id := range before {
		if _, ok := after[id]; !ok {
			removed = append(removed, id)
		}
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].ID < changed[j].ID })
	sort.Strings(removed)
	s.event("library", map[string]any{"fingerprint": second.fingerprint, "changed": changed, "removed": removed})
	for _, c := range changed {
		s.event("plan", map[string]any{"id": c.ID, "revision": c.Revision})
	}
}

func (s *Server) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *Server) scheduleScan() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if s.debounce != nil {
		s.debounce.Stop()
	}
	s.debounce = time.AfterFunc(s.watchDebounce, s.stableScan)
}

func (s *Server) event(kind string, value map[string]any) {
	s.mu.Lock()
	s.sequence++
	value["sequence"] = s.sequence
	seq := s.sequence
	s.mu.Unlock()
	data, _ := json.Marshal(value)
	s.broadcast(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", seq, kind, data))
}

func (s *Server) broadcast(wire string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.clients {
		select {
		case c <- wire:
		default:
		}
	}
}

func (s *Server) state() (int, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sequence, s.snapshot.fingerprint
}

func (s *Server) pandocAvailable() bool {
	s.pandocOnce.Do(func() {
		s.pandocOK = exec.Command("pandoc", "--version").Run() == nil
	})
	return s.pandocOK
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	host := strings.ToLower(r.Host)
	port := strconv.Itoa(s.Port)
	if host != "plans.localhost:"+port && host != "127.0.0.1:"+port && host != "localhost:"+port {
		writeError(w, 421, "unexpected host")
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || !allowedHostnames[u.Hostname()] || strings.ToLower(u.Host) != host {
		writeError(w, 403, "unexpected origin")
		return false
	}
	return true
}

func (s *Server) authorized(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("X-Csrf-Token") != s.csrf {
		writeError(w, 403, "invalid csrf token")
		return false
	}
	return true
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		writeError(w, 400, err.Error())
		return false
	}
	if len(data) > maxBodyBytes {
		writeError(w, 413, "request body too large")
		return false
	}
	_ = json.Unmarshal(data, v)
	return true
}

type summary struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Status     string   `json:"status"`
	Created    string   `json:"created"`
	Updated    string   `json:"updated"`
	Tags       []string `json:"tags"`
	Revision   string   `json:"revision"`
	URL        string   `json:"url"`
	IsArchived bool     `json:"isArchived"`
}

func planURL(id string) string { return "/plans/" + url.PathEscape(id) }

func (p *strictPlan) summary() summary {
	return summary{p.ID, p.Title, p.Status, p.Created, p.Updated, p.Tags, p.revision, planURL(p.ID), p.isArchived}
}

func matches(p *strictPlan, q string) bool {
	if q == "" || strings.Contains(strings.ToLower(p.Title), q) || strings.Contains(strings.ToLower(p.body), q) {
		return true
	}
	for _, t := range p.Tags {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

func lockConflict(err error) bool {
	var e *exitcode.Error
	return errors.As(err, &e) && e.Code == exitcode.Conflict
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	path := r.URL.Path
	seq, fingerprint := s.state()
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost

	switch {
	case get && path == "/_health":
		status, pandoc := "degraded", "unavailable"
		if s.pandocAvailable() {
			status, pandoc = "ok", "available"
		}
		writeJSON(w, 200, map[string]any{
			"status": status, "service": "plan-manager", "version": 1,
			"url": "http://plans.localhost:" + strconv.Itoa(s.Port) + "/", "host": s.host, "port": s.Port,
			"planHome": s.home, "pandoc": pandoc, "sequence": seq, "fingerprint": fingerprint,
		})
		return
	case get && path == "/_session":
		writeJSON(w, 200, map[string]any{"csrfToken": s.csrf, "sequence": seq, "fingerprint": fingerprint})
		return
	case get && path == "/_events":
		s.serveEvents(w, r)
		return
	case get && (path == "/api/plans" || path == "/api/search"):
		list, bad := s.index()
		q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
		out := []summary{}
		for _, p := range list {
			if matches(p, q) {
				out = append(out, p.summary())
			}
		}
		writeJSON(w, 200, map[string]any{"plans": out, "malformed": bad, "sequence": seq, "fingerprint": fingerprint})
		return
	}

	if m := detailRoute.FindStringSubmatch(path); get && m != nil {
		s.serveDetail(w, unescape(m[1]), seq)
		return
	}
	if m := taskRoute.FindStringSubmatch(path); post && m != nil {
		if s.authorized(w, r) {
			s.toggleTask(w, r, unescape(m[1]), m[2])
		}
		return
	}
	if m := actionRoute.FindStringSubmatch(path); post && m != nil {
		if !s.authorized(w, r) {
			return
		}
		id := unescape(m[1])
		switch m[2] {
		case "status":
			s.setStatus(w, r, id)
		case "archive":
			s.archivePlan(w, id)
		case "copy-path":
			if p, _ := s.findPlan(id); p != nil {
				writeJSON(w, 200, map[string]any{"id": id, "path": p.filePath})
			} else {
				writeError(w, 404, "plan not found")
			}
		case "open-in-editor":
			p, _ := s.findPlan(id)
			if p == nil {
				writeError(w, 404, "plan not found")
				return
			}
			editor := os.Getenv("EDITOR")
			if editor == "" {
				editor = "open"
			}
			c := exec.Command(editor, p.filePath)
			c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if c.Start() == nil {
				go c.Wait()
			}
			writeJSON(w, 200, map[string]any{"id": id, "opened": true})
		}
		return
	}

	if get && planPageRoute.MatchString(path) {
		s.serveAsset(w, "plan.html", "text/html; charset=utf-8", true)
		return
	}
	if get {
		switch path {
		case "/":
			s.serveAsset(w, "index.html", "text/html; charset=utf-8", true)
			return
		case "/icon.png":
			s.serveAsset(w, "icon.png", "image/png", false)
			return
		case "/style.css":
			s.serveAsset(w, "style.css", "text/css; charset=utf-8", false)
			return
		case "/app.js", "/plan.js":
			s.serveAsset(w, path[1:], "application/javascript; charset=utf-8", false)
			return
		}
	}
	writeError(w, 404, "not found")
}

func unescape(v string) string {
	if u, err := url.PathUnescape(v); err == nil {
		return u
	}
	return v
}

func (s *Server) serveAsset(w http.ResponseWriter, name, contentType string, html bool) {
	data, err := dashboardFS.ReadFile("dashboard/" + name)
	if err != nil {
		writeError(w, 500, "internal server error")
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	if html {
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		h.Set("X-Frame-Options", "DENY")
	}
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

func (s *Server) serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, "streaming unsupported")
		return
	}
	// Register before reading the sequence so no event can fall between the
	// connected payload and the first delivered event.
	ch := make(chan string, 64)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		writeError(w, 503, "server closing")
		return
	}
	s.clients[ch] = struct{}{}
	seq, fingerprint := s.sequence, s.snapshot.fingerprint
	s.mu.Unlock()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	last, _ := strconv.Atoi(r.Header.Get("Last-Event-ID"))
	data, _ := json.Marshal(map[string]any{"sequence": seq, "fingerprint": fingerprint, "missed": last < seq})
	fmt.Fprintf(w, "retry: 1000\nevent: connected\ndata: %s\n\n", data)
	flusher.Flush()
	defer func() {
		s.mu.Lock()
		if _, ok := s.clients[ch]; ok {
			delete(s.clients, ch)
		}
		s.mu.Unlock()
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if _, err := io.WriteString(w, msg); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) serveDetail(w http.ResponseWriter, id string, seq int) {
	p, err := s.findPlan(id)
	if err != nil {
		status := 500
		if errors.Is(err, errDuplicate) {
			status = 409
		}
		writeError(w, status, strings.TrimSuffix(err.Error(), ": "+errDuplicate.Error()))
		return
	}
	if p == nil {
		writeError(w, 404, "plan not found")
		return
	}
	var html any
	renderState := "unavailable"
	format := "md"
	if p.Format == "mdx" {
		// MDX blocks are rendered by the hosted app only; the dashboard shows
		// the source rather than letting pandoc mangle the JSX.
		format = "mdx"
	} else if s.pandocAvailable() {
		if out, err := RenderMarkdown(p.body); err == nil {
			html, renderState = out, "rendered"
		} else {
			renderState = "failed"
		}
	}
	writeJSON(w, 200, map[string]any{
		"id": p.ID, "title": p.Title, "status": p.Status, "created": p.Created, "updated": p.Updated,
		"tags": p.Tags, "revision": p.revision, "format": format, "body": p.body, "html": html, "renderState": renderState,
		"filePath": p.filePath, "url": planURL(p.ID), "isArchived": p.isArchived, "sequence": seq,
	})
}

func (s *Server) setStatus(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Status string `json:"status"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if !plans.IsStatus(body.Status) {
		writeError(w, 400, "invalid status")
		return
	}
	updated, err := lock.With(s.home, func() (*strictPlan, error) {
		p, err := s.findPlan(id)
		if err != nil || p == nil {
			return nil, err
		}
		meta := p.Meta
		meta.Status = body.Status
		return s.write(p, meta, p.body)
	})
	if lockConflict(err) {
		writeError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "internal server error")
		return
	}
	if updated == nil {
		writeError(w, 404, "plan not found")
		return
	}
	s.scheduleScan()
	writeJSON(w, 200, map[string]any{"id": id, "status": updated.Status, "revision": updated.revision, "url": planURL(id)})
}

func (s *Server) toggleTask(w http.ResponseWriter, r *http.Request, id, indexText string) {
	var body struct {
		Checked  *bool   `json:"checked"`
		Revision *string `json:"revision"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if body.Checked == nil || body.Revision == nil || !revisionPattern.MatchString(*body.Revision) {
		writeError(w, 400, "invalid task update")
		return
	}
	index, err := strconv.Atoi(indexText)
	if err != nil {
		writeError(w, 400, "invalid task index")
		return
	}
	type result struct {
		state string
		plan  *strictPlan
	}
	res, err := lock.With(s.home, func() (result, error) {
		p, err := s.findPlan(id)
		if err != nil {
			return result{}, err
		}
		if p == nil {
			return result{state: "not-found"}, nil
		}
		if p.revision != *body.Revision {
			return result{state: "stale"}, nil
		}
		next, ok := plans.UpdateTaskMarker(p.body, index, *body.Checked)
		if !ok {
			return result{state: "invalid-index"}, nil
		}
		np, err := s.write(p, p.Meta, next)
		return result{state: "updated", plan: np}, err
	})
	if lockConflict(err) {
		writeError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "internal server error")
		return
	}
	switch res.state {
	case "not-found":
		writeError(w, 404, "plan not found")
		return
	case "stale":
		writeError(w, 409, "stale plan revision")
		return
	case "invalid-index":
		writeError(w, 400, "invalid task index")
		return
	}
	s.scheduleScan()
	writeJSON(w, 200, map[string]any{"id": id, "index": index, "checked": *body.Checked, "revision": res.plan.revision, "url": planURL(id)})
}

func (s *Server) archivePlan(w http.ResponseWriter, id string) {
	state, err := lock.With(s.home, func() (string, error) {
		p, err := s.findPlan(id)
		if err != nil {
			return "", err
		}
		if p == nil {
			return "not-found", nil
		}
		if p.isArchived {
			return "archived", nil
		}
		dest := filepath.Join(s.archive, filepath.Base(p.filePath))
		if _, err := os.Lstat(dest); err == nil {
			return "collision", nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		meta := p.Meta
		meta.Status = plans.StatusArchived
		if _, err := s.write(p, meta, p.body); err != nil {
			return "", err
		}
		return "archived", os.Rename(p.filePath, dest)
	})
	if lockConflict(err) {
		writeError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "internal server error")
		return
	}
	switch state {
	case "not-found":
		writeError(w, 404, "plan not found")
		return
	case "collision":
		writeError(w, 409, "archive destination already exists")
		return
	}
	s.scheduleScan()
	writeJSON(w, 200, map[string]any{"id": id, "archived": true, "url": planURL(id)})
}

// RenderMarkdown converts Markdown to sanitized HTML with pandoc.
func RenderMarkdown(markdown string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// -raw_html alone leaves pandoc's raw_attribute extension on, so a
	// `...`{=html} span or fenced block still emits arbitrary HTML that
	// SanitizeHTML does not catch. Disable both.
	c := exec.CommandContext(ctx, "pandoc", "--from=markdown-raw_html-raw_attribute", "--to=html5", "--no-highlight")
	c.Stdin = strings.NewReader(markdown)
	var stdout, stderr bytes.Buffer
	c.Stdout = &limitedWriter{w: &stdout, n: 4 * 1024 * 1024}
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", errors.New(msg)
		}
		return "", err
	}
	return SanitizeHTML(stdout.String()), nil
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if len(p) > l.n {
		return 0, errors.New("Pandoc output too large")
	}
	l.n -= len(p)
	return l.w.Write(p)
}

var (
	inputTag      = regexp.MustCompile(`(?i)<input\b[^>]*/?>`)
	inputAllowed  = regexp.MustCompile(`(?i)^type\s*=\s*(?:"checkbox"|'checkbox'|checkbox)(?:\s+checked(?:\s*=\s*(?:""|''|checked))?)?\s*$`)
	checkedAttr   = regexp.MustCompile(`(?i)\bchecked\b`)
	dangerousTags = []string{"script", "style", "iframe", "object", "embed", "form", "button", "meta", "base"}
	pairedTags    []*regexp.Regexp
	openTags      = regexp.MustCompile(`(?i)<(?:script|style|iframe|object|embed|form|button|meta|base)\b[^>]*/?>`)
	eventHandlers = regexp.MustCompile(`(?i)\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`)
	unsafeURLsDQ  = regexp.MustCompile(`(?i)\s+(href|src)\s*=\s*"\s*(?:javascript|vbscript|data\s*:\s*text/html)[^"']*"`)
	unsafeURLsSQ  = regexp.MustCompile(`(?i)\s+(href|src)\s*=\s*'\s*(?:javascript|vbscript|data\s*:\s*text/html)[^"']*'`)
	inputPrefix   = regexp.MustCompile(`(?i)^<input\s*`)
	inputSuffix   = regexp.MustCompile(`/?\s*>$`)
	unsafeURLRepl = ` $1="#"`
)

func init() {
	for _, t := range dangerousTags {
		pairedTags = append(pairedTags, regexp.MustCompile(`(?is)<`+t+`\b.*?</`+t+`\s*>`))
	}
}

// SanitizeHTML strips active content from pandoc output, keeping only task
// checkboxes as inputs.
func SanitizeHTML(v string) string {
	v = inputTag.ReplaceAllStringFunc(v, func(input string) string {
		attrs := inputSuffix.ReplaceAllString(inputPrefix.ReplaceAllString(input, ""), "")
		if !inputAllowed.MatchString(attrs) {
			return ""
		}
		if checkedAttr.MatchString(attrs) {
			return `<input type="checkbox" data-plan-task="true" checked>`
		}
		return `<input type="checkbox" data-plan-task="true">`
	})
	for _, re := range pairedTags {
		v = re.ReplaceAllString(v, "")
	}
	v = openTags.ReplaceAllString(v, "")
	v = eventHandlers.ReplaceAllString(v, "")
	v = unsafeURLsDQ.ReplaceAllString(v, unsafeURLRepl)
	return unsafeURLsSQ.ReplaceAllString(v, unsafeURLRepl)
}
