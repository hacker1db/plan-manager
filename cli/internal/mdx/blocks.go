// Package mdx holds the MDX plan block vocabulary and the static checker
// behind `plan blocks` and `plan check`.
//
// blocks.json is the block registry. It was generated from the hosted app's
// renderer registry (src/lib/mdx/blocks.ts), which still renders MDX plans;
// keep the two in sync when a block or prop changes, so the catalog an agent
// reads never drifts from what the dashboards render.
package mdx

import (
	_ "embed"
	"fmt"
	"slices"
	"strings"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

//go:embed blocks.json
var blocksJSON []byte

// PropSpec describes one block prop.
type PropSpec struct {
	Name     string
	Type     string
	Required bool
	Values   []string
	Doc      string
}

// Block describes one MDX block component.
type Block struct {
	Name    string
	Summary string
	// Children is "markdown", "none", or the one element name a container
	// may hold (for example Tab inside Tabs).
	Children string
	Parent   string
	Props    []PropSpec
	Example  string
}

func (b *Block) prop(name string) *PropSpec {
	for i := range b.Props {
		if b.Props[i].Name == name {
			return &b.Props[i]
		}
	}
	return nil
}

// Blocks is the block registry, in catalog order.
var Blocks = mustLoadBlocks()

func mustLoadBlocks() []Block {
	v, err := ordered.DecodeJSON(blocksJSON)
	if err != nil {
		panic("mdx: invalid blocks.json: " + err.Error())
	}
	list, _ := v.(*ordered.Obj).Get("blocks")
	var blocks []Block
	for _, item := range list.([]any) {
		o := item.(*ordered.Obj)
		b := Block{Name: o.Str("name"), Summary: o.Str("summary"), Children: o.Str("children"), Parent: o.Str("parent"), Example: o.Str("example")}
		props, _ := o.Get("props")
		for _, name := range props.(*ordered.Obj).Keys() {
			raw, _ := props.(*ordered.Obj).Get(name)
			spec := raw.(*ordered.Obj)
			p := PropSpec{Name: name, Type: spec.Str("type"), Doc: spec.Str("doc")}
			p.Required, _ = must(spec.Get("required")).(bool)
			if values, ok := must(spec.Get("values")).([]any); ok {
				for _, value := range values {
					p.Values = append(p.Values, value.(string))
				}
			}
			b.Props = append(b.Props, p)
		}
		blocks = append(blocks, b)
	}
	return blocks
}

func must(v any, _ bool) any { return v }

// Lookup returns the block named name.
func Lookup(name string) *Block {
	for i := range Blocks {
		if Blocks[i].Name == name {
			return &Blocks[i]
		}
	}
	return nil
}

// CatalogJSON is the `plan blocks --json` document.
func CatalogJSON() []byte { return blocksJSON }

// typeOf names a static value's type the way the renderer's validation does.
func typeOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	}
	return "object"
}

// ValidateProps returns the problems with a block's props.
func ValidateProps(b *Block, props *ordered.Obj) []string {
	var problems []string
	for _, spec := range b.Props {
		value, ok := props.Get(spec.Name)
		if _, undefined := value.(undefinedValue); !ok || undefined {
			if spec.Required {
				problems = append(problems, fmt.Sprintf("missing required prop \"%s\"", spec.Name))
			}
			continue
		}
		if actual := typeOf(value); actual != spec.Type {
			problems = append(problems, fmt.Sprintf("prop \"%s\" must be %s, got %s", spec.Name, spec.Type, actual))
			continue
		}
		if spec.Values != nil && !slices.Contains(spec.Values, jsString(value)) {
			problems = append(problems, fmt.Sprintf("prop \"%s\" must be one of %s", spec.Name, strings.Join(spec.Values, ", ")))
		}
	}
	for _, name := range props.Keys() {
		if b.prop(name) == nil && name != "id" {
			problems = append(problems, fmt.Sprintf("unknown prop \"%s\"", name))
		}
	}
	return problems
}

// Reference is the Markdown block reference `plan blocks` prints.
func Reference() string {
	lines := []string{
		"# MDX plan blocks",
		"",
		"Capitalized tags below are the only block components an MDX plan may use. Props are static",
		"literals: strings, numbers, booleans, arrays, and objects. Expressions, imports, exports, and",
		"unknown components render as an error card instead of running. Every block also accepts `id`.",
		"",
	}
	for _, b := range Blocks {
		lines = append(lines, "## <"+b.Name+">", "", b.Summary, "")
		if b.Parent != "" {
			lines = append(lines, "Only valid inside <"+b.Parent+">.", "")
		}
		children := "<" + b.Children + "> elements"
		switch b.Children {
		case "markdown":
			children = "Markdown"
		case "none":
			children = "none (self-closing)"
		}
		lines = append(lines, "Children: "+children, "")
		if len(b.Props) > 0 {
			lines = append(lines, "| Prop | Type | Required | Notes |", "| --- | --- | --- | --- |")
			for _, p := range b.Props {
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
		lines = append(lines, "```mdx", b.Example, "```", "")
	}
	return strings.Join(lines, "\n")
}
