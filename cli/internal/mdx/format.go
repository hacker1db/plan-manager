package mdx

import "regexp"

var (
	frontmatterRe = regexp.MustCompile(`^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)`)
	formatLineRe  = regexp.MustCompile(`(?m)^format:\s*["']?mdx["']?\s*$`)
)

// SourceFormat is "mdx" when the frontmatter declares `format: mdx`, the
// portable signal that survives `plan push`; the .mdx extension is only the
// on-disk convention.
func SourceFormat(source string) string {
	if m := frontmatterRe.FindStringSubmatch(source); m != nil && formatLineRe.MatchString(m[1]) {
		return "mdx"
	}
	return "md"
}

// StripFrontmatter returns source without its YAML frontmatter.
func StripFrontmatter(source string) string {
	return frontmatterRe.ReplaceAllString(source, "")
}
