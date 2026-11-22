package mdxrender

import (
	"sort"
	"strings"
)

// With indented code disabled, micromark treats indentation inside a JSX
// element as insignificant except relative to lists and fences, so
//
//	<Tabs>
//	  <Tab label="a">
//	    - item
//	  </Tab>
//	</Tabs>
//
// holds a list. goldmark keeps CommonMark's four-column limits, so before
// parsing, the children of each column-zero flow element are dedented by
// their common indentation. Relative indentation is preserved, and offsets
// map back to the original source for error positions.

type srcLine struct {
	text string // including its line ending
	off  int    // original offset of text[0]
}

type dedented struct {
	source string
	starts []int // transformed offset of each line
	lines  []srcLine
}

func splitSourceLines(src string) []srcLine {
	var lines []srcLine
	for off := 0; off < len(src); {
		end := strings.IndexByte(src[off:], '\n')
		if end < 0 {
			end = len(src)
		} else {
			end += off + 1
		}
		lines = append(lines, srcLine{text: src[off:end], off: off})
		off = end
	}
	return lines
}

func leadingSpaces(s string) int {
	n := 0
	for n < len(s) && s[n] == ' ' {
		n++
	}
	return n
}

func blank(s string) bool { return strings.TrimSpace(s) == "" }

// fence reports a fence opener (``` or ~~~) and returns its marker run.
func fence(s string) string {
	t := strings.TrimLeft(s, " ")
	for _, c := range []byte{'`', '~'} {
		n := 0
		for n < len(t) && t[n] == c {
			n++
		}
		if n >= 3 && (c == '~' || !strings.Contains(t[n:], "`")) {
			return t[:n]
		}
	}
	return ""
}

func closesFence(s, marker string) bool {
	t := strings.TrimSpace(s)
	return strings.HasPrefix(t, marker) && strings.Trim(t, marker[:1]) == ""
}

// openingTag reports a line holding only an opening (not self-closing) tag,
// returning its name and how many lines the tag spans.
//
// The tag is scanned in a window of lines that doubles while the scan crashes
// at the window's end. Scanning the whole remainder at every `<` line was
// quadratic in the plan's length. A scan that succeeds, declines, or crashes
// before the window's end reads the same characters either way.
func openingTag(lines []srcLine, i int, budget *workBudget) (string, int) {
	var tag *jsxTag
	var sc *scanner
	for n := 1; ; n *= 2 {
		end := min(i+n, len(lines))
		var window strings.Builder
		for j := i; j < end; j++ {
			window.WriteString(lines[j].text)
		}
		if !budget.spend(window.Len()) {
			return "", 0
		}
		sc = &scanner{s: window.String(), budget: budget}
		var ok bool
		var err error
		tag, ok, err = sc.scanTag()
		if err != nil && sc.i >= len(sc.s) && end < len(lines) {
			continue
		}
		if err != nil || !ok || tag.close || tag.selfClosing || tag.name == "" {
			return "", 0
		}
		break
	}
	tail := sc.s[sc.i:]
	if nl := strings.IndexByte(tail, '\n'); nl >= 0 {
		tail = tail[:nl]
	}
	if !blank(tail) {
		return "", 0
	}
	return tag.name, strings.Count(sc.s[:sc.i], "\n") + 1
}

func tagLine(s, prefix, name string) bool {
	t := strings.TrimLeft(s, " \t")
	if !strings.HasPrefix(t, prefix+name) {
		return false
	}
	r, _ := (&scanner{s: t[len(prefix+name):]}).peek()
	return r < 0 || r == '>' || r == '/' || isLineEndingOrSpace(r) || r == '{'
}

// maxDedentWork bounds the lines dedentRange visits. Finding each element's
// closing tag scans ahead, so deeply nested or unclosed elements cost
// quadratic work; past the bound the remaining elements keep their source
// indentation.
const maxDedentWork = 4_000_000

func dedentRange(lines []srcLine, from, to int, work *int, budget *workBudget) {
	for i := from; i < to; {
		if *work <= 0 || budget.exhausted() {
			return
		}
		if marker := fence(lines[i].text); marker != "" {
			for i++; i < to && !closesFence(lines[i].text, marker); i++ {
			}
			i++
			continue
		}
		if lines[i].text == "" || lines[i].text[0] != '<' {
			i++
			continue
		}
		name, span := openingTag(lines[:to], i, budget)
		if name == "" {
			i++
			continue
		}
		start := i + span
		closing, depth := -1, 0
		for j := start; j < to && closing < 0; j++ {
			*work--
			if marker := fence(lines[j].text); marker != "" {
				for j++; j < to && !closesFence(lines[j].text, marker); j++ {
				}
				continue
			}
			switch {
			case tagLine(lines[j].text, "</", name):
				if depth == 0 {
					closing = j
				}
				depth--
			case tagLine(lines[j].text, "<", name) && !strings.Contains(lines[j].text, "/>"):
				depth++
			}
		}
		if closing < 0 {
			i++
			continue
		}
		base := -1
		for j := start; j < closing; j++ {
			if !blank(lines[j].text) {
				if n := leadingSpaces(lines[j].text); base < 0 || n < base {
					base = n
				}
			}
		}
		if base > 0 {
			for j := start; j < closing; j++ {
				n := min(base, leadingSpaces(lines[j].text))
				if blank(lines[j].text) {
					n = min(n, len(strings.TrimRight(lines[j].text, "\r\n")))
				}
				lines[j].text = lines[j].text[n:]
				lines[j].off += n
			}
		}
		*work -= closing - start
		dedentRange(lines, start, closing, work, budget)
		i = closing + 1
	}
}

func dedent(src string, budget *workBudget) *dedented {
	lines := splitSourceLines(src)
	work := maxDedentWork
	dedentRange(lines, 0, len(lines), &work, budget)
	d := &dedented{lines: lines}
	var b strings.Builder
	for _, l := range lines {
		d.starts = append(d.starts, b.Len())
		b.WriteString(l.text)
	}
	d.source = b.String()
	return d
}

// original maps an offset in the dedented source back to the input.
func (d *dedented) original(offset int) int {
	if len(d.lines) == 0 {
		return offset
	}
	i := sort.Search(len(d.starts), func(i int) bool { return d.starts[i] > offset }) - 1
	if i < 0 {
		i = 0
	}
	return d.lines[i].off + offset - d.starts[i]
}
