package plans

import (
	"regexp"
	"strings"
)

// Review comments are stored in the plan body as inline HTML comments at the
// end of the line they refer to:
//
//   - [ ] Ship the migration <!-- plan-comment: split this into two steps -->
//
// Obsidian and other CommonMark renderers hide them, agents reading the file
// see them, and the local dashboard lists them beside the source editor.
var (
	commentMarker = regexp.MustCompile(`[ \t]*<!--\s*plan-comment:(.*?)-->`)
	fenceOpen     = regexp.MustCompile("^[ \t]*(`{3,}|~{3,})")
)

// Comment is one review marker in a plan body.
type Comment struct {
	// Line is the 1-based body line that holds the marker.
	Line int    `json:"line"`
	Text string `json:"text"`
}

// fencedLines reports, per line, whether it sits inside (or delimits) a
// fenced code block. Markers there are code, not comments.
func fencedLines(lines []string) []bool {
	out := make([]bool, len(lines))
	fence := ""
	for i, line := range lines {
		if fence != "" {
			out[i] = true
			trimmed := strings.TrimLeft(line, " \t")
			if strings.HasPrefix(trimmed, fence) && strings.TrimSpace(strings.TrimLeft(trimmed, fence[:1])) == "" {
				fence = ""
			}
			continue
		}
		if m := fenceOpen.FindStringSubmatch(line); m != nil {
			out[i] = true
			fence = m[1]
		}
	}
	return out
}

// Comments lists the review markers in body in document order.
func Comments(body string) []Comment {
	lines := strings.Split(body, "\n")
	fenced := fencedLines(lines)
	out := []Comment{}
	for i, line := range lines {
		if fenced[i] {
			continue
		}
		for _, m := range commentMarker.FindAllStringSubmatch(line, -1) {
			out = append(out, Comment{Line: i + 1, Text: strings.TrimSpace(m[1])})
		}
	}
	return out
}

// StripComments removes review markers so a renderer that would show HTML
// comments as text (pandoc without raw_html) displays only the plan.
func StripComments(body string) string {
	lines := strings.Split(body, "\n")
	fenced := fencedLines(lines)
	for i, line := range lines {
		if fenced[i] || !strings.Contains(line, "plan-comment:") {
			continue
		}
		lines[i] = strings.TrimRight(commentMarker.ReplaceAllString(line, ""), " \t")
	}
	return strings.Join(lines, "\n")
}
