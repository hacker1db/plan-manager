package plans

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hacker1db/plan-manager/cli/internal/tracking"
)

const (
	StatusActive    = "active"
	StatusCompleted = "completed"
	StatusArchived  = "archived"
)

var Statuses = []string{StatusActive, StatusCompleted, StatusArchived}

func IsStatus(s string) bool {
	for _, v := range Statuses {
		if v == s {
			return true
		}
	}
	return false
}

// Meta is the normalized frontmatter of a plan. Extra holds unknown keys so
// rewriting a plan never drops frontmatter the user added by hand.
type Meta struct {
	ID      string
	Title   string
	Status  string
	Created string
	Updated string
	Tags    []string
	Source  string
	// Format is "mdx" for MDX plans and empty for Markdown.
	Format string
	// SchemaVersion and Tracking are the tracking schema and the raw,
	// unvalidated tracking block; see package tracking.
	SchemaVersion *int
	Tracking      *yaml.Node
	Extra         []Field
}

// TrackingSource is the metadata package tracking reads.
func (m Meta) TrackingSource() tracking.Source {
	return tracking.Source{ID: m.ID, Status: m.Status, SchemaVersion: m.SchemaVersion, Raw: m.Tracking}
}

type Field struct {
	Key   string
	Value *yaml.Node
}

// Plan is a plan file read from disk.
type Plan struct {
	Meta     Meta
	Body     string
	Raw      string
	FilePath string
}

func (p *Plan) Revision() string { return Revision(p.Raw) }

// Raw is the unvalidated frontmatter mapping of a Markdown document.
type Raw struct {
	keys   []string
	values map[string]*yaml.Node
}

func (r Raw) Len() int { return len(r.keys) }

func (r Raw) node(key string) *yaml.Node {
	if r.values == nil {
		return nil
	}
	return r.values[key]
}

// Str returns the value of key when it is a non-null scalar.
func (r Raw) Str(key string) (string, bool) {
	n := r.node(key)
	if n == nil || n.Kind != yaml.ScalarNode || n.Tag == "!!null" {
		return "", false
	}
	return n.Value, true
}

// List returns the scalar items of key when it is a sequence.
func (r Raw) List(key string) ([]string, bool) {
	n := r.node(key)
	if n == nil || n.Kind != yaml.SequenceNode {
		return nil, false
	}
	out := []string{}
	for _, item := range n.Content {
		if item.Kind == yaml.ScalarNode && item.Tag != "!!null" {
			out = append(out, item.Value)
		}
	}
	return out, true
}

// ParseFrontmatter splits a Markdown document into its YAML frontmatter and
// body. Malformed or missing frontmatter yields an empty Raw.
func ParseFrontmatter(content string) (Raw, string) {
	if !strings.HasPrefix(content, "---") {
		return Raw{}, content
	}
	end := strings.Index(content[3:], "\n---")
	if end == -1 {
		return Raw{}, content
	}
	end += 3
	yamlText := strings.TrimSpace(content[3:end])
	body := strings.TrimPrefix(content[end+4:], "\n")
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(yamlText), &doc); err != nil || len(doc.Content) == 0 {
		return Raw{}, body
	}
	m := doc.Content[0]
	if m.Kind != yaml.MappingNode {
		return Raw{}, body
	}
	raw := Raw{values: map[string]*yaml.Node{}}
	for i := 0; i+1 < len(m.Content); i += 2 {
		k := m.Content[i].Value
		if _, dup := raw.values[k]; !dup {
			raw.keys = append(raw.keys, k)
		}
		raw.values[k] = m.Content[i+1]
	}
	return raw, body
}

var knownKeys = map[string]bool{"id": true, "title": true, "status": true, "created": true, "updated": true, "tags": true, "source": true, "format": true, "schemaVersion": true, "tracking": true}

// NormalizeMeta fills defaults for missing or invalid frontmatter fields.
func NormalizeMeta(raw Raw) Meta {
	now := Now()
	m := Meta{Status: StatusActive, Created: now, Updated: now, Tags: []string{}}
	if v, ok := raw.Str("id"); ok && v != "" {
		m.ID = v
	} else {
		m.ID = GenerateID()
	}
	if v, ok := raw.Str("title"); ok && v != "" {
		m.Title = v
	} else {
		m.Title = "Untitled"
	}
	if v, ok := raw.Str("status"); ok && IsStatus(v) {
		m.Status = v
	}
	if v, ok := raw.Str("created"); ok {
		m.Created = v
	}
	if v, ok := raw.Str("updated"); ok {
		m.Updated = v
	}
	if v, ok := raw.List("tags"); ok {
		m.Tags = v
	}
	if v, ok := raw.Str("source"); ok {
		m.Source = v
	}
	if v, ok := raw.Str("format"); ok && v == "mdx" {
		m.Format = "mdx"
	}
	if n := raw.node("schemaVersion"); n != nil && n.Kind == yaml.ScalarNode && n.Tag == "!!int" {
		var v int
		if n.Decode(&v) == nil {
			m.SchemaVersion = &v
		}
	}
	if n := raw.node("tracking"); n != nil && n.Tag != "!!null" {
		m.Tracking = detach(n)
	}
	for _, k := range raw.keys {
		if !knownKeys[k] {
			m.Extra = append(m.Extra, Field{Key: k, Value: detach(raw.values[k])})
		}
	}
	return m
}

// detach deep-copies n with aliases replaced by their targets and anchors
// dropped, so a preserved key never refers to an anchor on a key that Render
// rewrites.
func detach(n *yaml.Node) *yaml.Node {
	if n == nil {
		return nil
	}
	if n.Kind == yaml.AliasNode && n.Alias != nil {
		return detach(n.Alias)
	}
	c := *n
	c.Anchor = ""
	c.Content = make([]*yaml.Node, len(n.Content))
	for i, child := range n.Content {
		c.Content[i] = detach(child)
	}
	return &c
}

func strNode(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
}

// Render serializes meta and body into the on-disk Markdown format.
func Render(meta Meta, body string) (string, error) {
	m := &yaml.Node{Kind: yaml.MappingNode}
	add := func(k string, v *yaml.Node) { m.Content = append(m.Content, strNode(k), v) }
	add("id", strNode(meta.ID))
	add("title", strNode(meta.Title))
	add("status", strNode(meta.Status))
	add("created", strNode(meta.Created))
	add("updated", strNode(meta.Updated))
	tags := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	if len(meta.Tags) == 0 {
		tags.Style = yaml.FlowStyle
	}
	for _, t := range meta.Tags {
		tags.Content = append(tags.Content, strNode(t))
	}
	add("tags", tags)
	if meta.Source != "" {
		add("source", strNode(meta.Source))
	}
	if meta.Format == "mdx" {
		add("format", strNode("mdx"))
	}
	if meta.SchemaVersion != nil {
		add("schemaVersion", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(*meta.SchemaVersion)})
	}
	if meta.Tracking != nil {
		add("tracking", meta.Tracking)
	}
	for _, f := range meta.Extra {
		add(f.Key, f.Value)
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(m); err != nil {
		return "", err
	}
	_ = enc.Close()
	var check yaml.Node
	if err := yaml.Unmarshal(buf.Bytes(), &check); err != nil {
		return "", fmt.Errorf("refusing to write unparseable frontmatter: %w", err)
	}
	if !strings.HasPrefix(body, "\n") {
		body = "\n" + body
	}
	return "---\n" + strings.TrimRight(buf.String(), "\n") + "\n---\n" + body, nil
}

// Now returns the current time in the same ISO-8601 form JavaScript's
// Date#toISOString produces.
func Now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

const idAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

// GenerateID returns a 21-character URL-safe random ID (nanoid compatible).
func GenerateID() string {
	b := make([]byte, 21)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = idAlphabet[b[i]&63]
	}
	return string(b)
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify converts a title into a filename slug.
func Slugify(title string) string {
	s := nonSlug.ReplaceAllString(strings.ToLower(title), "-")
	s = strings.Trim(s, "-")
	if len(s) > 80 {
		s = s[:80]
	}
	if s == "" {
		return "plan"
	}
	return s
}

// Revision is the SHA-256 of the full file content.
func Revision(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}
