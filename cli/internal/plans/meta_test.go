package plans

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Migrate Auth Service!": "migrate-auth-service",
		"  --Hello__World--  ":  "hello-world",
		"!!!":                   "plan",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
	if got := Slugify(strings.Repeat("a", 100)); len(got) != 80 {
		t.Errorf("slug not truncated: %d", len(got))
	}
}

func TestGenerateID(t *testing.T) {
	re := regexp.MustCompile(`^[A-Za-z0-9_-]{21}$`)
	seen := map[string]bool{}
	for range 100 {
		id := GenerateID()
		if !re.MatchString(id) || seen[id] {
			t.Fatalf("bad or duplicate id %q", id)
		}
		seen[id] = true
	}
}

func TestRenderRoundTrip(t *testing.T) {
	meta := Meta{ID: "abc123", Title: "Q4: roadmap", Status: "active", Created: "2026-10-04T20:00:00.000Z", Updated: "2026-10-04T20:00:00.000Z", Tags: []string{"backend", "auth"}, Source: "/tmp/x.md"}
	out, err := Render(meta, "## Tasks\n\n- [ ] one\n")
	if err != nil {
		t.Fatal(err)
	}
	want := "---\nid: abc123\ntitle: 'Q4: roadmap'\nstatus: active\ncreated: \"2026-10-04T20:00:00.000Z\"\nupdated: \"2026-10-04T20:00:00.000Z\"\ntags:\n  - backend\n  - auth\nsource: /tmp/x.md\n---\n\n## Tasks\n\n- [ ] one\n"
	if out != want {
		t.Fatalf("render mismatch:\n%s\nwant:\n%s", out, want)
	}
	raw, body := ParseFrontmatter(out)
	got := NormalizeMeta(raw)
	if got.Title != meta.Title || got.Created != meta.Created || len(got.Tags) != 2 || got.Source != meta.Source {
		t.Fatalf("round trip lost data: %+v", got)
	}
	again, _ := Render(got, body)
	if again != out {
		t.Fatalf("render not stable:\n%s\nvs\n%s", again, out)
	}
}

func TestEmptyTagsAndExtraKeysPreserved(t *testing.T) {
	src := "---\nid: x1\ntitle: T\nstatus: bogus\ncreated: 2026-01-01T00:00:00.000Z\nowner: dana\n---\nbody\n"
	raw, body := ParseFrontmatter(src)
	m := NormalizeMeta(raw)
	if m.Status != "active" {
		t.Errorf("invalid status not defaulted: %q", m.Status)
	}
	if m.Created != "2026-01-01T00:00:00.000Z" {
		t.Errorf("unquoted timestamp not kept as string: %q", m.Created)
	}
	out, _ := Render(m, body)
	if !strings.Contains(out, "tags: []\n") || !strings.Contains(out, "owner: dana\n") {
		t.Fatalf("unexpected render:\n%s", out)
	}
}

func TestParseFrontmatterWithoutFrontmatter(t *testing.T) {
	raw, body := ParseFrontmatter("# Just markdown\n")
	if raw.Len() != 0 || body != "# Just markdown\n" {
		t.Fatalf("got %d keys, body %q", raw.Len(), body)
	}
}

func TestContainedRejectsSymlinkEscape(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	t.Setenv("PLAN_HOME", home)
	if err := InitStorage(); err != nil {
		t.Fatal(err)
	}
	if !Contained(filepath.Join(home, "a.md")) {
		t.Error("plain path should be contained")
	}
	link := filepath.Join(home, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if Contained(filepath.Join(link, "a.md")) {
		t.Error("symlinked directory should not be contained")
	}
	if Contained(filepath.Join(home, "..", "a.md")) {
		t.Error("parent path should not be contained")
	}
}

func TestResolveAmbiguousSlug(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PLAN_HOME", home)
	if err := InitStorage(); err != nil {
		t.Fatal(err)
	}
	for i, p := range []string{PlanPath("dup", "md"), ArchivePath("dup", "md")} {
		m := Meta{ID: []string{"id-one", "id-two"}[i], Title: "Dup", Status: "active", Tags: []string{}}
		if err := Write(p, m, "x"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Resolve("dup"); err == nil || !strings.Contains(err.Error(), "Ambiguous") {
		t.Fatalf("expected ambiguous error, got %v", err)
	}
	if p, err := Resolve("id-two"); err != nil || p.Meta.ID != "id-two" {
		t.Fatalf("resolve by id failed: %v", err)
	}
}

func TestAliasedExtraKeysSurviveRewrite(t *testing.T) {
	src := "---\nid: abcd1234\ntitle: &t Foo\nstatus: active\ncreated: x\nupdated: x\ntags: []\nalias: *t\nbase: &b {k: v}\nmerged: {<<: *b, z: 1}\n---\nbody\n"
	raw, body := ParseFrontmatter(src)
	out, err := Render(NormalizeMeta(raw), body)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := ParseFrontmatter(out)
	m := NormalizeMeta(again)
	if m.ID != "abcd1234" || m.Title != "Foo" {
		t.Fatalf("rewrite corrupted frontmatter:\n%s", out)
	}
	if v, _ := again.Str("alias"); v != "Foo" {
		t.Fatalf("alias not resolved:\n%s", out)
	}
}
