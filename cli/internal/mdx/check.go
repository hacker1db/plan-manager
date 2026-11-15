package mdx

import (
	"fmt"
	"html"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

// Check returns the problems in an MDX plan body (frontmatter already
// stripped): unknown or misplaced blocks, invalid props, imports, exports,
// and {expressions}. A document that does not parse yields one
// "MDX could not be parsed" problem.
//
// This is a static scanner, not a full MDX parser. It finds JSX tags the
// way MDX does — a line holding only tags is a block-level ("flow") tag,
// anything else is inline text — and skips code spans and fenced code.
func Check(source string) []string {
	raw := splitLines(source)
	c := &checker{raw: raw}
	for _, line := range raw {
		c.lines = append(c.lines, stripContainers(line))
	}
	c.text = strings.Join(raw, "\n")
	offset := 0
	for i, line := range raw {
		c.starts = append(c.starts, offset+len(line)-len(c.lines[i]))
		c.ends = append(c.ends, offset+len(line))
		offset += len(line) + 1
	}
	if err := c.run(); err != nil {
		return []string{"MDX could not be parsed: " + err.Error()}
	}
	return c.problems()
}

type parseError struct{ msg string }

func (e *parseError) Error() string { return e.msg }

func parseErrorf(format string, args ...any) *parseError {
	return &parseError{fmt.Sprintf(format, args...)}
}

// record is a block (a capitalized element) or a construct that renders as
// an error card (an import, export, or expression).
type record struct {
	name   string
	parent int // index of the nearest enclosing block record, or -1
	err    string
}

// frame is an open element. rec is -1 for HTML elements and fragments,
// which are transparent to block nesting.
type frame struct {
	name  string
	rec   int
	stray bool // a container holds something other than its child element
}

type checker struct {
	raw     []string // source lines
	lines   []string // source lines without list and blockquote markers
	text    string   // the source, with markers, for constructs that span lines
	starts  []int    // offset in text of each line's content after its markers
	ends    []int    // offset in text of each line's end
	records []record
	stack   []frame
}

var listMarkerRe = regexp.MustCompile(`^([-*+]|\d{1,9}[.)])([ \t]|$)`)

// stripContainers removes indentation and list and blockquote markers: JSX
// and expressions inside list items and quotes behave as at the top level.
func stripContainers(line string) string {
	for {
		line = strings.TrimLeft(line, " \t")
		if strings.HasPrefix(line, ">") {
			line = line[1:]
			continue
		}
		if m := listMarkerRe.FindStringIndex(line); m != nil {
			line = line[m[1]:]
			continue
		}
		return line
	}
}

func splitLines(source string) []string {
	source = strings.ReplaceAll(source, "\r\n", "\n")
	return strings.Split(strings.ReplaceAll(source, "\r", "\n"), "\n")
}

// problems lists record errors in document order, skipping records whose
// block never renders its children: one that has an error itself, or one
// without children.
func (c *checker) problems() []string {
	var out []string
	for _, r := range c.records {
		if r.err == "" || c.hidden(r.parent) {
			continue
		}
		out = append(out, r.err)
	}
	return out
}

func (c *checker) hidden(i int) bool {
	for ; i >= 0; i = c.records[i].parent {
		r := c.records[i]
		if r.err != "" {
			return true
		}
		if b := Lookup(r.name); b != nil && b.Children == "none" {
			return true
		}
	}
	return false
}

// parent is the innermost open block record.
func (c *checker) parent() int {
	for i := len(c.stack) - 1; i >= 0; i-- {
		if c.stack[i].rec >= 0 {
			return c.stack[i].rec
		}
	}
	return -1
}

func (c *checker) fail(message string) {
	c.records = append(c.records, record{parent: c.parent(), err: message})
}

// content notes block-level content in the innermost open element; a
// container such as Tabs may hold only its child elements.
func (c *checker) content(element string) {
	if len(c.stack) == 0 {
		return
	}
	top := &c.stack[len(c.stack)-1]
	if top.rec < 0 {
		return
	}
	if b := Lookup(top.name); b != nil && b.Children != "markdown" && b.Children != "none" && element != b.Children {
		top.stray = true
	}
}

var (
	fenceRe   = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)$")
	headingRe = regexp.MustCompile(`^ {0,3}#{1,6}(\s|$)`)
	esmRe     = regexp.MustCompile(`^(import|export)\b`)
	aliases   = map[string]string{
		"ApiEndpoint": "Endpoint", "Diagram": "Flow or Layers", "FileMap": "FileTree", "Mermaid": "Flow or Layers",
		"QuestionForm": "Questions", "RichText": "plain Markdown", "TabsBlock": "Tabs",
	}
)

func unknownBlockMessage(name string) string {
	match := ""
	for _, b := range Blocks {
		if strings.EqualFold(b.Name, name) {
			match = b.Name
			break
		}
	}
	if match == "" {
		match = aliases[name]
	}
	switch {
	case match == "":
		return "Unknown block <" + name + ">"
	case strings.Contains(match, " "):
		return "Unknown block <" + name + "> — did you mean " + match + "?"
	}
	return "Unknown block <" + name + "> — did you mean <" + match + ">?"
}

func blank(line string) bool { return strings.TrimSpace(line) == "" }

func (c *checker) run() error {
	n := len(c.lines)
	for i := 0; i < n; {
		line := c.lines[i]
		switch {
		case blank(line):
			i++
		case fenceRe.MatchString(line):
			c.content("")
			i = c.skipFence(i)
		case len(c.stack) == 0 && esmRe.MatchString(c.raw[i]):
			// An import or export runs to the next blank line.
			start := i
			for i < n && !blank(c.lines[i]) {
				i++
			}
			if !esmStatements(c.raw[start:i]) {
				return parseErrorf("Could not parse import/exports with acorn")
			}
			c.fail("import and export statements are not supported in plans")
		case c.flowExpression(i) > 0:
			start := c.starts[i]
			end, _ := matchBrace(c.text, start, '{', '}')
			if err := checkExpression(c.text[start+1 : end-1]); err != nil {
				return err
			}
			c.content("")
			c.fail(`{expressions} are not supported in plans; escape braces as \{ or use a code span`)
			i = c.flowExpression(i)
		default:
			next, flow, err := c.flowTags(i, true)
			if err != nil {
				return err
			}
			if flow {
				i = next
				continue
			}
			if headingRe.MatchString(line) {
				c.content("")
				if err := c.inline(line); err != nil {
					return err
				}
				i++
				continue
			}
			// A paragraph runs until a blank line, fence, heading, or a line
			// of block-level tags.
			j := i + 1
			for j < n && !blank(c.lines[j]) && !fenceRe.MatchString(c.lines[j]) && !headingRe.MatchString(c.lines[j]) {
				if _, flow, _ := c.flowTags(j, false); flow || c.flowExpression(j) > 0 {
					break
				}
				j++
			}
			c.content("")
			if err := c.inline(c.text[c.starts[i]:c.ends[j-1]]); err != nil {
				return err
			}
			i = j
		}
	}
	if len(c.stack) > 0 {
		return parseErrorf("Expected a closing tag for `%s` before the end of document", tagText(c.stack[len(c.stack)-1].name))
	}
	return nil
}

// esmStatements approximates MDX's check that an import/export block is
// valid JavaScript: every line outside an open bracket must start a new
// import or export statement.
func esmStatements(lines []string) bool {
	depth := 0
	for _, line := range lines {
		if depth == 0 && !esmRe.MatchString(strings.TrimLeft(line, " \t")) {
			return false
		}
		for i := 0; i < len(line); i++ {
			switch line[i] {
			case '"', '\'', '`':
				q := line[i]
				for i++; i < len(line) && line[i] != q; i++ {
					if line[i] == '\\' {
						i++
					}
				}
			case '{', '(', '[':
				depth++
			case '}', ')', ']':
				depth--
			}
		}
	}
	return depth == 0
}

func tagText(name string) string { return "<" + name + ">" }

func (c *checker) skipFence(i int) int {
	m := fenceRe.FindStringSubmatch(c.lines[i])
	marker := m[1]
	for j := i + 1; j < len(c.lines); j++ {
		trimmed := strings.TrimLeft(c.lines[j], " ")
		if len(c.lines[j])-len(trimmed) <= 3 && strings.HasPrefix(trimmed, marker[:1]) {
			run := len(trimmed) - len(strings.TrimLeft(trimmed, marker[:1]))
			if run >= len(marker) && blank(trimmed[run:]) {
				return j + 1
			}
		}
	}
	return len(c.lines)
}

// flowExpression returns the line after a block-level expression that
// starts line i — an {expression} followed only by whitespace — or 0.
func (c *checker) flowExpression(i int) int {
	text := c.text[c.starts[i]:]
	if !strings.HasPrefix(text, "{") {
		return 0
	}
	end, ok := matchBrace(text, 0, '{', '}')
	if !ok {
		return 0
	}
	rest := text[end:]
	if eol := strings.IndexByte(rest, '\n'); eol >= 0 {
		rest = rest[:eol]
	}
	if !blank(rest) {
		return 0
	}
	return i + strings.Count(text[:end], "\n") + 1
}

// flowTags parses line i as a line of block-level tags: one or more tags
// (which may span lines) followed only by whitespace. When apply is true the
// tags are applied to the element stack. It returns the line after the tags.
func (c *checker) flowTags(i int, apply bool) (next int, flow bool, err error) {
	text := c.text[c.starts[i]:]
	pos := 0
	if !strings.HasPrefix(text, "<") || len(text) > 1 && unicode.IsSpace(rune(text[1])) {
		return 0, false, nil
	}
	var tags []*tag
	for pos < len(text) && text[pos] == '<' {
		t, perr := parseTag(text, pos)
		if perr != nil {
			return 0, false, nil
		}
		tags = append(tags, t)
		pos = t.end
		for pos < len(text) && (text[pos] == ' ' || text[pos] == '\t') {
			pos++
		}
	}
	if pos < len(text) && text[pos] != '\n' {
		return 0, false, nil
	}
	if apply {
		for _, t := range tags {
			if err := c.applyFlow(t); err != nil {
				return 0, false, err
			}
		}
	}
	return i + strings.Count(text[:pos], "\n") + 1, true, nil
}

func isBlockName(name string) bool {
	r, _ := utf8.DecodeRuneInString(name)
	return name != "" && !unicode.IsLower(r)
}

// openRecord creates the record for a capitalized element.
func (c *checker) openRecord(t *tag, flow bool) int {
	parent := c.parent()
	r := record{name: t.name, parent: parent}
	parentName := ""
	if parent >= 0 {
		parentName = c.records[parent].name
	}
	spec := Lookup(t.name)
	switch {
	case spec == nil:
		r.err = unknownBlockMessage(t.name)
	case !flow:
		r.err = "<" + t.name + "> is a block: put its opening and closing tags on their own lines"
	case spec.Parent != "" && parentName != spec.Parent:
		r.err = "<" + t.name + "> is only valid inside <" + spec.Parent + ">"
	default:
		if props, err := staticProps(t.attrs); err != nil {
			r.err = "<" + t.name + ">: " + err.Error()
		} else if problems := ValidateProps(spec, props); len(problems) > 0 {
			r.err = "<" + t.name + ">: " + strings.Join(problems, "; ")
		}
	}
	c.records = append(c.records, r)
	return len(c.records) - 1
}

func (c *checker) push(t *tag, flow bool) {
	rec := -1
	if isBlockName(t.name) {
		rec = c.openRecord(t, flow)
	}
	if !t.selfClosing {
		c.stack = append(c.stack, frame{name: t.name, rec: rec})
	}
}

func (c *checker) pop(t *tag) error {
	if len(c.stack) == 0 {
		return parseErrorf("Unexpected closing slash `/` in tag, expected an open tag first")
	}
	top := c.stack[len(c.stack)-1]
	if top.name != t.name {
		return parseErrorf("Unexpected closing tag `</%s>`, expected corresponding closing tag for `%s`", t.name, tagText(top.name))
	}
	c.stack = c.stack[:len(c.stack)-1]
	if top.rec >= 0 && top.stray && c.records[top.rec].err == "" {
		spec := Lookup(top.name)
		c.records[top.rec].err = "<" + top.name + "> may only contain <" + spec.Children + "> elements"
	}
	return nil
}

func (c *checker) applyFlow(t *tag) error {
	if t.closing {
		return c.pop(t)
	}
	if t.name == "" || isBlockName(t.name) {
		c.content(t.name)
	} else {
		c.content("<" + t.name)
	}
	c.push(t, true)
	return nil
}

// inline scans paragraph text for inline tags, expressions, and code spans.
func (c *checker) inline(text string) error {
	depth := len(c.stack)
	for pos := 0; pos < len(text); {
		ch := text[pos]
		switch {
		case ch == '\\' && pos+1 < len(text) && isASCIIPunct(text[pos+1]):
			pos += 2
		case ch == '`':
			pos = skipCodeSpan(text, pos)
		case ch == '{':
			end, ok := matchBrace(text, pos, '{', '}')
			if !ok {
				return parseErrorf("Unexpected end of file in expression, expected a corresponding closing brace for `{`")
			}
			if err := checkExpression(text[pos+1 : end-1]); err != nil {
				return err
			}
			c.fail("{expressions} are not supported in plans")
			pos = end
		case ch == '<' && pos+1 < len(text) && unicode.IsSpace(rune(text[pos+1])):
			// "a < b" is text, not a tag.
			pos++
		case ch == '<':
			t, err := parseTag(text, pos)
			if err != nil {
				return err
			}
			if t.closing {
				if len(c.stack) <= depth {
					return parseErrorf("Unexpected closing slash `/` in tag, expected an open tag first")
				}
				if err := c.pop(t); err != nil {
					return err
				}
			} else {
				c.push(t, false)
			}
			pos = t.end
		default:
			pos++
		}
	}
	if len(c.stack) > depth {
		return parseErrorf("Expected a closing tag for `%s` before the end of `paragraph`", tagText(c.stack[len(c.stack)-1].name))
	}
	return nil
}

func isASCIIPunct(b byte) bool {
	return b >= '!' && b <= '/' || b >= ':' && b <= '@' || b >= '[' && b <= '`' || b >= '{' && b <= '~'
}

// skipCodeSpan skips a code span opened by the backtick run at pos, or just
// the run when it is never closed.
func skipCodeSpan(text string, pos int) int {
	run := 0
	for pos+run < len(text) && text[pos+run] == '`' {
		run++
	}
	for i := pos + run; i < len(text); {
		if text[i] != '`' {
			i++
			continue
		}
		j := i
		for j < len(text) && text[j] == '`' {
			j++
		}
		if j-i == run {
			return j
		}
		i = j
	}
	return pos + run
}

// tag is a parsed JSX tag. name is empty for fragments.
type tag struct {
	name        string
	closing     bool
	selfClosing bool
	attrs       []attr
	end         int
}

// attr is a JSX attribute: name="text", name={expression}, a bare name, or
// a spread {...expression}.
type attr struct {
	name   string
	spread bool
	bare   bool
	text   *string
	expr   *string
}

func isNameStart(r rune) bool { return r == '$' || r == '_' || unicode.IsLetter(r) }
func isNamePart(r rune) bool  { return isNameStart(r) || unicode.IsDigit(r) || r == '-' }

func charError(text string, pos int, expected string) error {
	if pos >= len(text) {
		return parseErrorf("Unexpected end of file %s", expected)
	}
	r, _ := utf8.DecodeRuneInString(text[pos:])
	return parseErrorf("Unexpected character `%c` (U+%04X) %s", r, r, expected)
}

func skipJSXSpace(text string, pos int) int {
	for pos < len(text) {
		r, size := utf8.DecodeRuneInString(text[pos:])
		if !unicode.IsSpace(r) {
			break
		}
		pos += size
	}
	return pos
}

func readName(text string, pos int) (string, int) {
	start := pos
	for pos < len(text) {
		r, size := utf8.DecodeRuneInString(text[pos:])
		if (pos == start && !isNameStart(r)) || (pos > start && !isNamePart(r)) {
			break
		}
		pos += size
	}
	return text[start:pos], pos
}

// parseTag parses the JSX tag that starts with "<" at pos.
func parseTag(text string, pos int) (*tag, error) {
	t := &tag{}
	pos = skipJSXSpace(text, pos+1)
	if pos < len(text) && text[pos] == '/' {
		t.closing = true
		pos = skipJSXSpace(text, pos+1)
	}
	if pos < len(text) && text[pos] == '>' {
		t.end = pos + 1
		return t, nil
	}
	name, next := readName(text, pos)
	if name == "" {
		expected := "before name, expected a character that can start a name, such as a letter, `$`, or `_`"
		if pos < len(text) && text[pos] == '!' {
			expected += " (note: to create a comment in MDX, use `{/* text */}`)"
		}
		return nil, charError(text, pos, expected)
	}
	pos = next
	// Member (a.b) and namespace (a:b) names.
	for pos < len(text) && (text[pos] == '.' || text[pos] == ':') {
		part, next := readName(text, pos+1)
		if part == "" {
			return nil, charError(text, pos+1, "in name, expected a name character")
		}
		name += text[pos:pos+1] + part
		pos = next
	}
	t.name = name
	for {
		pos = skipJSXSpace(text, pos)
		if pos >= len(text) {
			return nil, charError(text, pos, "in tag, expected `>`")
		}
		switch {
		case text[pos] == '>':
			t.end = pos + 1
			return t, nil
		case strings.HasPrefix(text[pos:], "/>") && !t.closing:
			t.selfClosing = true
			t.end = pos + 2
			return t, nil
		case t.closing:
			return nil, charError(text, pos, "after name in closing tag, expected `>`")
		case text[pos] == '{':
			end, ok := matchBrace(text, pos, '{', '}')
			if !ok {
				return nil, parseErrorf("Unexpected end of file in expression, expected a corresponding closing brace for `{`")
			}
			body := text[pos+1 : end-1]
			if !strings.HasPrefix(strings.TrimSpace(body), "...") {
				return nil, parseErrorf("Unexpected `%s` in attribute, expected a spread `{...props}`", body)
			}
			t.attrs = append(t.attrs, attr{spread: true})
			pos = end
		default:
			attrName, next := readName(text, pos)
			if attrName == "" {
				return nil, charError(text, pos, "before attribute name, expected a character that can start an attribute name")
			}
			pos = next
			for pos < len(text) && text[pos] == ':' {
				part, next := readName(text, pos+1)
				attrName += ":" + part
				pos = next
			}
			a := attr{name: attrName}
			after := skipJSXSpace(text, pos)
			if after >= len(text) || text[after] != '=' {
				a.bare = true
				t.attrs = append(t.attrs, a)
				continue
			}
			pos = skipJSXSpace(text, after+1)
			if pos >= len(text) {
				return nil, charError(text, pos, "before attribute value")
			}
			switch q := text[pos]; q {
			case '"', '\'':
				end := strings.IndexByte(text[pos+1:], q)
				if end < 0 {
					return nil, parseErrorf("Unexpected end of file in attribute value, expected a corresponding closing quote `%c`", q)
				}
				value := html.UnescapeString(text[pos+1 : pos+1+end])
				a.text = &value
				pos += end + 2
			case '{':
				end, ok := matchBrace(text, pos, '{', '}')
				if !ok {
					return nil, parseErrorf("Unexpected end of file in expression, expected a corresponding closing brace for `{`")
				}
				body := text[pos+1 : end-1]
				// MDX parses every attribute expression, so one that is not
				// valid JavaScript makes the document unparseable.
				_, single, err := parseProgram(body)
				switch {
				case err != nil:
					return nil, parseErrorf("Could not parse expression with acorn: %s", err.Error())
				case !single && emptyExpression(body):
					return nil, parseErrorf("Unexpected empty expression")
				case !single:
					return nil, parseErrorf("Could not parse expression with acorn")
				}
				a.expr = &body
				pos = end
			default:
				return nil, charError(text, pos, "before attribute value, expected a character that can start an attribute value, such as `\"`, `'`, or `{`")
			}
			t.attrs = append(t.attrs, a)
		}
	}
}

// checkExpression requires an {expression} body to be one JavaScript
// expression, or empty: MDX parses expressions even though plans reject them.
func checkExpression(body string) error {
	_, single, err := parseProgram(body)
	if err != nil || !single && !emptyExpression(body) {
		return parseErrorf("Could not parse expression with acorn")
	}
	return nil
}

// emptyExpression reports whether an expression holds only whitespace and
// comments.
func emptyExpression(body string) bool {
	p := &exprParser{src: body}
	defer func() { _ = recover() }()
	p.skipSpace()
	return p.eof()
}

// staticProps evaluates a block's attributes into props.
func staticProps(attrs []attr) (*ordered.Obj, error) {
	props := ordered.New()
	for _, a := range attrs {
		if a.spread {
			return nil, &staticError{"spread attributes are not supported"}
		}
		if forbiddenKeys[a.name] {
			return nil, &staticError{fmt.Sprintf("prop \"%s\" is not allowed", a.name)}
		}
		switch {
		case a.bare:
			props.Set(a.name, true)
		case a.text != nil:
			props.Set(a.name, *a.text)
		default:
			n, single, err := parseProgram(*a.expr)
			if err != nil {
				return nil, err
			}
			if !single {
				return nil, &staticError{fmt.Sprintf("prop \"%s\" must be a single static value", a.name)}
			}
			if n.err != nil {
				return nil, n.err
			}
			props.Set(a.name, n.value)
		}
	}
	return props, nil
}
