// Package mdxrender parses and renders MDX plans without evaluating them. It is a
// port of src/lib/mdx (shared with the hosted app), which is the spec: the block
// registry, static prop evaluation, validation messages, and HTML output.
package mdxrender

import (
	"fmt"
	"slices"
	"strings"
)

// Block vocabulary for MDX plans. This registry is the single source of truth
// for the renderer's validation and for `plan blocks`, so the catalog an agent
// reads can never drift from what the dashboards actually render.

// PropSpec describes one block prop. Field order matches the TypeScript
// literals so `plan blocks --json` is byte-identical.
type PropSpec struct {
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Values   []string `json:"values,omitempty"`
	Doc      string   `json:"doc"`
}

// Prop is a named PropSpec; props keep their declaration order.
type Prop struct {
	Name string
	PropSpec
}

// Props marshals as a JSON object in declaration order.
type Props []Prop

func (p Props) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, prop := range p {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := marshalJSON(prop.Name)
		if err != nil {
			return nil, err
		}
		value, err := marshalJSON(prop.PropSpec)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// BlockSpec describes one block component.
type BlockSpec struct {
	Name     string `json:"name"`
	Summary  string `json:"summary"`
	Children string `json:"children"`
	Parent   string `json:"parent,omitempty"`
	Props    Props  `json:"props"`
	Example  string `json:"example"`
}

func (b *BlockSpec) prop(name string) (PropSpec, bool) {
	for _, p := range b.Props {
		if p.Name == name {
			return p.PropSpec, true
		}
	}
	return PropSpec{}, false
}

var changeValues = []string{"added", "modified", "removed", "renamed"}

var (
	change  = PropSpec{Type: "string", Values: changeValues, Doc: "Diff-aware flag rendered as a badge"}
	title   = PropSpec{Type: "string", Doc: "Heading shown above the block"}
	summary = PropSpec{Type: "string", Doc: "One-line description shown under the title"}
)

// Blocks is the block catalog, in `plan blocks` order.
var Blocks = []BlockSpec{
	{
		Name:     "Callout",
		Summary:  "Highlighted note for a decision, risk, warning, or outcome.",
		Children: "markdown",
		Props: Props{
			{"tone", PropSpec{Type: "string", Values: []string{"note", "info", "decision", "warning", "risk", "success"}, Doc: "Visual tone; defaults to note"}},
			{"title", title},
		},
		Example: "<Callout tone=\"decision\" title=\"Store MDX next to Markdown\">\nPlans keep YAML frontmatter; only the body syntax changes.\n</Callout>",
	},
	{
		Name:     "Columns",
		Summary:  "Side-by-side container for structured comparisons such as Before / After.",
		Children: "Column",
		Props:    Props{{"title", title}},
		Example:  "<Columns>\n<Column label=\"Before\">\nPandoc renders Markdown only.\n</Column>\n<Column label=\"After\">\nMDX plans render typed blocks.\n</Column>\n</Columns>",
	},
	{
		Name:     "Column",
		Summary:  "One column inside Columns.",
		Children: "markdown",
		Parent:   "Columns",
		Props:    Props{{"label", PropSpec{Type: "string", Doc: "Column heading, e.g. Before or After"}}},
		Example:  "<Column label=\"After\">\n...\n</Column>",
	},
	{
		Name:     "Tabs",
		Summary:  "Horizontal tabs; use under a \"## Key changes\" heading to group Diff blocks.",
		Children: "Tab",
		Props:    Props{{"title", title}},
		Example:  "<Tabs>\n<Tab label=\"storage.ts\">\n<Diff filename=\"src/lib/storage.ts\" before={\"a\"} after={\"b\"} />\n</Tab>\n</Tabs>",
	},
	{
		Name:     "Tab",
		Summary:  "One panel inside Tabs.",
		Children: "markdown",
		Parent:   "Tabs",
		Props:    Props{{"label", PropSpec{Type: "string", Required: true, Doc: "Tab label, usually a file basename"}}},
		Example:  "<Tab label=\"render.tsx\">\n...\n</Tab>",
	},
	{
		Name:     "FileTree",
		Summary:  "Footprint of the change: files grouped by directory with change flags and stats.",
		Children: "none",
		Props: Props{
			{"title", title},
			{"files", PropSpec{Type: "array", Required: true, Doc: "[{ path, change?, note?, additions?, deletions? }]"}},
		},
		Example: "<FileTree files={[{ path: \"src/lib/mdx/render.tsx\", change: \"added\", note: \"MDX renderer\", additions: 420 }, { path: \"src/lib/storage.ts\", change: \"modified\", additions: 12, deletions: 4 }]} />",
	},
	{
		Name:     "Diff",
		Summary:  "Literal before/after code with optional line annotations. Split mode by default.",
		Children: "none",
		Props: Props{
			{"filename", PropSpec{Type: "string", Required: true, Doc: "Path shown in the header"}},
			{"language", PropSpec{Type: "string", Doc: "Language label"}},
			{"before", PropSpec{Type: "string", Required: true, Doc: "Old text; use a JSON string such as {\"line 1\\nline 2\"}"}},
			{"after", PropSpec{Type: "string", Required: true, Doc: "New text"}},
			{"mode", PropSpec{Type: "string", Values: []string{"split", "unified"}, Doc: "Defaults to split"}},
			{"summary", summary},
			{"annotations", PropSpec{Type: "array", Doc: "[{ line, note, side?: \"before\" | \"after\" }] — line numbers default to the after side"}},
		},
		Example: "<Diff filename=\"src/lib/storage.ts\" summary=\"List .mdx plans alongside .md\" before={\"if (!name.endsWith('.md')) continue\"} after={\"if (!isPlanFilename(name)) continue\"} annotations={[{ line: 1, note: \"Accepts .md and .mdx\" }]} />",
	},
	{
		Name:     "AnnotatedCode",
		Summary:  "A new file or added block, with notes pinned to the lines that matter.",
		Children: "none",
		Props: Props{
			{"filename", PropSpec{Type: "string", Required: true, Doc: "Path shown in the header"}},
			{"language", PropSpec{Type: "string", Doc: "Language label"}},
			{"code", PropSpec{Type: "string", Required: true, Doc: "Source text as a JSON string"}},
			{"summary", summary},
			{"annotations", PropSpec{Type: "array", Doc: "[{ line, note }]"}},
		},
		Example: "<AnnotatedCode filename=\"src/lib/mdx/format.ts\" code={\"export function isMdx(meta) {\\n  return meta.format === 'mdx'\\n}\"} annotations={[{ line: 2, note: \"Frontmatter is the portable signal\" }]} />",
	},
	{
		Name:     "DataModel",
		Summary:  "Entities, fields, and relations, with per-field change flags and prior types.",
		Children: "none",
		Props: Props{
			{"title", title},
			{"entities", PropSpec{Type: "array", Required: true, Doc: "[{ name, change?, note?, fields: [{ name, type, key?: \"pk\" | \"fk\", change?, was?, note? }] }]"}},
			{"relations", PropSpec{Type: "array", Doc: "[{ from, to, label? }]"}},
		},
		Example: "<DataModel entities={[{ name: \"PlanMetadata\", fields: [{ name: \"id\", type: \"string\", key: \"pk\" }, { name: \"format\", type: \"\\\"md\\\" | \\\"mdx\\\"\", change: \"added\" }] }]} />",
	},
	{
		Name:     "Endpoint",
		Summary:  "HTTP contract after the change. Children are the prose description.",
		Children: "markdown",
		Props: Props{
			{"method", PropSpec{Type: "string", Required: true, Values: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}, Doc: "HTTP method"}},
			{"path", PropSpec{Type: "string", Required: true, Doc: "Route path"}},
			{"change", change},
			{"deprecated", PropSpec{Type: "boolean", Doc: "Marks a removed or retired route"}},
			{"params", PropSpec{Type: "array", Doc: "[{ name, in: \"path\" | \"query\" | \"header\" | \"body\", type, required?, change?, was?, note? }]"}},
			{"request", PropSpec{Type: "object", Doc: "{ contentType?, example? } — example is a single JSON value as a string"}},
			{"responses", PropSpec{Type: "array", Doc: "[{ status, description?, example?, change? }]"}},
		},
		Example: "<Endpoint method=\"GET\" path=\"/api/plans/:id\" responses={[{ status: 200, example: \"{\\\"format\\\":\\\"mdx\\\"}\" }]}>\nReturns rendered HTML for Markdown and MDX plans.\n</Endpoint>",
	},
	{
		Name:     "Flow",
		Summary:  "Ordered steps with arrows, for genuinely sequential mechanics.",
		Children: "none",
		Props: Props{
			{"title", title},
			{"direction", PropSpec{Type: "string", Values: []string{"horizontal", "vertical"}, Doc: "Defaults to horizontal"}},
			{"steps", PropSpec{Type: "array", Required: true, Doc: "[{ label, detail?, change? }]"}},
		},
		Example: "<Flow steps={[{ label: \"plan.mdx\", detail: \"frontmatter + MDX\" }, { label: \"remark-mdx\", detail: \"parse, never eval\" }, { label: \"React\", detail: \"whitelisted blocks\" }]} />",
	},
	{
		Name:     "Layers",
		Summary:  "Stacked groups (layers, regions, ownership boundaries) for architecture.",
		Children: "none",
		Props: Props{
			{"title", title},
			{"layers", PropSpec{Type: "array", Required: true, Doc: "[{ label, note?, items: [string | { label, change?, note? }] }]"}},
		},
		Example: "<Layers layers={[{ label: \"Surfaces\", items: [\"Local dashboard\", \"Hosted app\"] }, { label: \"Renderer\", items: [{ label: \"src/lib/mdx\", change: \"added\" }] }]} />",
	},
	{
		Name:     "Questions",
		Summary:  "The single bottom block of open questions, each with a recommended default.",
		Children: "none",
		Props: Props{
			{"title", title},
			{"items", PropSpec{Type: "array", Required: true, Doc: "[{ question, recommendation?, options?: string[] }]"}},
		},
		Example: "<Questions items={[{ question: \"Render Mermaid?\", recommendation: \"Defer; needs client JS\", options: [\"Defer\", \"Bundle mermaid\"] }]} />",
	},
}

func blockByName(name string) *BlockSpec {
	for i := range Blocks {
		if Blocks[i].Name == name {
			return &Blocks[i]
		}
	}
	return nil
}

func typeOf(v value) string {
	switch v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case *array:
		return "array"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	}
	return "object"
}

func validateBlockProps(spec *BlockSpec, props *object) []string {
	var problems []string
	for _, p := range spec.Props {
		v, ok := props.get(p.Name)
		if !ok || v == undefined {
			if p.Required {
				problems = append(problems, fmt.Sprintf("missing required prop %q", p.Name))
			}
			continue
		}
		actual := typeOf(v)
		if actual != p.Type {
			problems = append(problems, fmt.Sprintf("prop %q must be %s, got %s", p.Name, p.Type, actual))
			continue
		}
		if p.Values != nil && !slices.Contains(p.Values, jsString(v)) {
			problems = append(problems, fmt.Sprintf("prop %q must be one of %s", p.Name, strings.Join(p.Values, ", ")))
		}
	}
	for _, name := range props.keys {
		if _, ok := spec.prop(name); !ok && name != "id" {
			problems = append(problems, fmt.Sprintf("unknown prop %q", name))
		}
	}
	return problems
}

// BlocksReference renders the Markdown catalog printed by `plan blocks`.
func BlocksReference() string {
	lines := []string{
		"# MDX plan blocks",
		"",
		"Capitalized tags below are the only block components an MDX plan may use. Props are static",
		"literals: strings, numbers, booleans, arrays, and objects. Expressions, imports, exports, and",
		"unknown components render as an error card instead of running. Every block also accepts `id`.",
		"",
	}
	for _, block := range Blocks {
		lines = append(lines, "## <"+block.Name+">", "", block.Summary, "")
		if block.Parent != "" {
			lines = append(lines, "Only valid inside <"+block.Parent+">.", "")
		}
		children := "<" + block.Children + "> elements"
		switch block.Children {
		case "markdown":
			children = "Markdown"
		case "none":
			children = "none (self-closing)"
		}
		lines = append(lines, "Children: "+children, "")
		if len(block.Props) > 0 {
			lines = append(lines, "| Prop | Type | Required | Notes |", "| --- | --- | --- | --- |")
			for _, p := range block.Props {
				typ := p.Type
				if p.Values != nil {
					quoted := make([]string, len(p.Values))
					for i, v := range p.Values {
						quoted[i] = `"` + v + `"`
					}
					typ = strings.Join(quoted, ` \| `)
				}
				required := ""
				if p.Required {
					required = "yes"
				}
				lines = append(lines, fmt.Sprintf("| %s | %s | %s | %s |", p.Name, typ, required, strings.ReplaceAll(p.Doc, "|", `\|`)))
			}
			lines = append(lines, "")
		}
		lines = append(lines, "```mdx", block.Example, "```", "")
	}
	return strings.Join(lines, "\n")
}

// CatalogJSON is the `plan blocks --json` document, without a trailing
// newline.
func CatalogJSON() ([]byte, error) {
	return marshalJSON(struct {
		Version int         `json:"version"`
		Blocks  []BlockSpec `json:"blocks"`
	}{1, Blocks})
}
