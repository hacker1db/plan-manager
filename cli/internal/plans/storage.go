package plans

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/hacker1db/plan-manager/cli/internal/config"
	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrAmbiguous     = errors.New("ambiguous")
	ErrPathTraversal = errors.New("path traversal")
	ErrNotDir        = errors.New("not a directory")
)

func Home() string       { return config.PlanHome() }
func ArchiveDir() string { return filepath.Join(Home(), "archive") }

func PlanPath(slug string) string    { return filepath.Join(Home(), slug+".md") }
func ArchivePath(slug string) string { return filepath.Join(ArchiveDir(), slug+".md") }

func abs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return a
}

func inside(root, target string) bool {
	return target == root || strings.HasPrefix(target, root+string(filepath.Separator))
}

// Inside reports whether target is lexically inside root.
func Inside(root, target string) bool { return inside(abs(root), abs(target)) }

// realTarget resolves the deepest existing ancestor of path. It returns ""
// when that ancestor (or path itself) is a symlink.
func realTarget(path string) (string, error) {
	current := path
	var missing []string
	for {
		info, err := os.Lstat(current)
		if err == nil {
			if info.Mode()&fs.ModeSymlink != 0 {
				return "", nil
			}
			real, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			return filepath.Join(append([]string{real}, missing...)...), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append([]string{filepath.Base(current)}, missing...)
		current = parent
	}
}

// Contained reports whether path resolves inside the plan home without
// passing through a symlink.
func Contained(path string) bool {
	root := abs(Home())
	target := abs(path)
	if !inside(root, target) {
		return false
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	resolved, err := realTarget(target)
	if err != nil || resolved == "" {
		return false
	}
	return inside(filepath.Clean(rootReal), filepath.Clean(resolved))
}

// InitStorage creates the plan home and archive directory.
func InitStorage() error {
	for i, dir := range []string{Home(), ArchiveDir()} {
		info, err := os.Lstat(dir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err == nil && (!info.IsDir() || info.Mode()&fs.ModeSymlink != 0) {
			return exitcode.New(exitcode.StorageUnavailable, "Path exists but is not a directory: %s", dir)
		}
		if err != nil {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return exitcode.New(exitcode.StorageUnavailable, "%s", err.Error())
			}
		}
		if i == 1 && !Contained(dir) {
			return exitcode.New(exitcode.PathTraversal, "Path escapes plan home: %s", dir)
		}
	}
	return nil
}

func markdownFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if Contained(p) {
			files = append(files, p)
		}
	}
	return files
}

func ListPlanFiles() []string    { return markdownFiles(Home()) }
func ListArchiveFiles() []string { return markdownFiles(ArchiveDir()) }
func AllPlanFiles() []string     { return append(ListPlanFiles(), ListArchiveFiles()...) }

// IsArchivedPath reports whether a plan file lives in the archive directory.
func IsArchivedPath(path string) bool {
	return abs(filepath.Dir(path)) == abs(ArchiveDir())
}

// Read loads and normalizes a plan file.
func Read(path string) (*Plan, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	raw := string(data)
	fm, body := ParseFrontmatter(raw)
	return &Plan{Meta: NormalizeMeta(fm), Body: body, Raw: raw, FilePath: path}, nil
}

// Write stamps meta.Updated and atomically rewrites path.
func Write(path string, meta Meta, body string) error {
	meta.Updated = Now()
	content, err := Render(meta, body)
	if err != nil {
		return err
	}
	return AtomicWrite(path, content)
}

// AtomicWrite writes content to a temp file beside path and renames it into
// place, refusing paths that escape the plan home.
func AtomicWrite(path, content string) error {
	escape := exitcode.New(exitcode.PathTraversal, "Path escapes plan home: %s", path)
	if !Contained(path) {
		return escape
	}
	suffix := make([]byte, 8)
	_, _ = rand.Read(suffix)
	tmp := filepath.Join(filepath.Dir(path), fmt.Sprintf(".%s.%s.tmp", filepath.Base(path), hex.EncodeToString(suffix)))
	defer os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if !Contained(path) {
		return escape
	}
	return os.Rename(tmp, path)
}

// Resolve finds a plan by exact ID, or by filename slug when the slug is
// unique across the plan home and archive.
func Resolve(idOrSlug string) (*Plan, error) {
	var matches []*Plan
	for _, f := range AllPlanFiles() {
		p, err := Read(f)
		if err != nil {
			continue
		}
		if p.Meta.ID == idOrSlug {
			return p, nil
		}
		if strings.TrimSuffix(filepath.Base(f), ".md") == idOrSlug {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "Plan not found: %s", idOrSlug)
	}
	ids := make([]string, len(matches))
	for i, m := range matches {
		ids[i] = m.Meta.ID
	}
	return nil, exitcode.New(exitcode.Ambiguous, "Ambiguous identifier %q matches: %s", idOrSlug, strings.Join(ids, ", "))
}

func exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// UniqueSlug returns base, or base-N for the first free N in 2..99.
func UniqueSlug(base string) (string, error) {
	if ok, err := exists(PlanPath(base)); err != nil || !ok {
		return base, err
	}
	for i := 2; i <= 99; i++ {
		c := fmt.Sprintf("%s-%d", base, i)
		if ok, err := exists(PlanPath(c)); err != nil || !ok {
			return c, err
		}
	}
	return "", fmt.Errorf("No available filename slot for slug %q", base)
}

// UniqueArchivePath returns a free archive path for slug.
func UniqueArchivePath(slug string) (string, error) {
	first := ArchivePath(slug)
	if ok, err := exists(first); err != nil || !ok {
		return first, err
	}
	for i := 2; i <= 999; i++ {
		c := ArchivePath(fmt.Sprintf("%s-%d", slug, i))
		if ok, err := exists(c); err != nil || !ok {
			return c, err
		}
	}
	return "", fmt.Errorf("No available archive filename slot for slug %q", slug)
}

// Slug returns the filename slug of a plan path.
func Slug(path string) string { return strings.TrimSuffix(filepath.Base(path), ".md") }

// Envelope is the versioned JSON shape commands print with --json.
type Envelope struct {
	Version  int      `json:"version"`
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Status   string   `json:"status"`
	Path     string   `json:"path"`
	URL      string   `json:"url"`
	Revision string   `json:"revision"`
	Created  string   `json:"created"`
	Updated  string   `json:"updated"`
	Tags     []string `json:"tags"`
}

func (p *Plan) Envelope() Envelope {
	tags := p.Meta.Tags
	if tags == nil {
		tags = []string{}
	}
	return Envelope{
		Version: 1, ID: p.Meta.ID, Title: p.Meta.Title, Status: p.Meta.Status,
		Path: p.FilePath, URL: config.PlanURL(p.Meta.ID), Revision: p.Revision(),
		Created: p.Meta.Created, Updated: p.Meta.Updated, Tags: tags,
	}
}
