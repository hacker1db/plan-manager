package plans

import (
	"regexp"
	"strings"
)

// taskMarker matches Markdown task checkboxes. Its leading \s* may span blank
// lines; indexes are counted per match, matching the dashboard's numbering.
var taskMarker = regexp.MustCompile(`(?m)^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]`)

// Task is one Markdown checkbox in a plan body.
type Task struct {
	Index   int
	Checked bool
	Text    string
	Depth   int
}

// Tasks lists the checkboxes in body in document order.
func Tasks(body string) []Task {
	var out []Task
	for i, loc := range taskMarker.FindAllStringSubmatchIndex(body, -1) {
		rest := body[loc[1]:]
		if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
			rest = rest[:nl]
		}
		prefix := body[loc[2]:loc[3]]
		if nl := strings.LastIndexByte(prefix, '\n'); nl >= 0 {
			prefix = prefix[nl+1:]
		}
		indent := len(prefix) - len(strings.TrimLeft(prefix, " \t"))
		out = append(out, Task{Index: i, Checked: body[loc[4]:loc[5]] != " ", Text: strings.TrimSpace(rest), Depth: indent / 2})
	}
	return out
}

// UpdateTaskMarker sets the index-th checkbox in body. It reports false when
// there is no such task.
func UpdateTaskMarker(body string, index int, checked bool) (string, bool) {
	current, updated := -1, false
	mark := " "
	if checked {
		mark = "x"
	}
	out := taskMarker.ReplaceAllStringFunc(body, func(match string) string {
		current++
		if current != index {
			return match
		}
		updated = true
		return taskMarker.FindStringSubmatch(match)[1] + "[" + mark + "]"
	})
	return out, updated
}
