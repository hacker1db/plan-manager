package mdxrender

import "regexp"

// RenderHTML renders an MDX plan body to static HTML. MDX is parsed, never
// evaluated: expressions, imports, exports, and unknown tags become error
// cards, raw HTML and unsafe URLs never reach the output, and images render
// as their alt text.
func RenderHTML(source string) string {
	html, _ := render(source)
	return html
}

// Check returns the problems `plan check` reports, in render order.
func Check(source string) []string {
	_, problems := render(source)
	if problems == nil {
		problems = []string{}
	}
	return problems
}

var (
	frontmatter = regexp.MustCompile(`^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)`)
	formatMdx   = regexp.MustCompile(`(?m)^format:\s*["']?mdx["']?\s*$`)
)

// SourceFormat reports "mdx" when the frontmatter declares `format: mdx`.
func SourceFormat(source string) string {
	m := frontmatter.FindStringSubmatch(source)
	if m != nil && formatMdx.MatchString(m[1]) {
		return "mdx"
	}
	return "md"
}

// StripFrontmatter removes a leading YAML frontmatter block.
func StripFrontmatter(source string) string {
	if loc := frontmatter.FindStringIndex(source); loc != nil {
		return source[loc[1]:]
	}
	return source
}
