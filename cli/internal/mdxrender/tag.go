package mdxrender

import (
	"fmt"
	"html"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Ports of micromark-extension-mdx-jsx's factoryTag and
// micromark-factory-mdx-expression. They scan a string from an offset and
// either succeed, decline (nok: the text is not a tag), or crash with the
// exact message micromark throws.

type jsxAttr struct {
	name     string
	spread   bool
	hasValue bool
	value    string
	expr     *jsNode
}

type jsxTag struct {
	name        string
	close       bool
	selfClosing bool
	attrs       []jsxAttr
	start, end  int // absolute source offsets
}

func abbreviated(t *jsxTag) string {
	if t.close {
		return "</" + t.name + ">"
	}
	return "<" + t.name + ">"
}

type syntaxError struct{ msg string }

func (e *syntaxError) Error() string { return e.msg }

type scanner struct {
	s   string
	i   int
	off int // absolute offset of s[0]
}

func (sc *scanner) eof() bool { return sc.i >= len(sc.s) }

func (sc *scanner) peek() (rune, int) {
	if sc.i >= len(sc.s) {
		return -1, 0
	}
	if sc.s[sc.i] == '\r' && sc.i+1 < len(sc.s) && sc.s[sc.i+1] == '\n' {
		return '\r', 2
	}
	return utf8.DecodeRuneInString(sc.s[sc.i:])
}

func isLineEnding(r rune) bool { return r == '\n' || r == '\r' }

func isMarkdownSpace(r rune) bool { return r == ' ' || r == '\t' }

// isUnicodeWhitespace is JavaScript's /\s/.
func isUnicodeWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func isLineEndingOrSpace(r rune) bool { return isLineEnding(r) || isMarkdownSpace(r) }

func crash(r rune, at, expect string) error {
	what := "end of file"
	if r >= 0 {
		char := string(r)
		if r == '`' {
			char = "` ` `"
		}
		what = fmt.Sprintf("character `%s` (U+%04X)", char, r)
	}
	return &syntaxError{msg: "Unexpected " + what + " " + at + ", expected " + expect}
}

// ws skips JSX whitespace, including line endings (esWhitespace).
func (sc *scanner) ws() {
	for !sc.eof() {
		r, size := sc.peek()
		if !isLineEnding(r) && !isMarkdownSpace(r) && !isUnicodeWhitespace(r) {
			return
		}
		sc.i += size
	}
}

func (sc *scanner) idStart() bool {
	r, _ := sc.peek()
	return r >= 0 && isIDStart(r)
}

// name consumes identifier characters; JSX names may also contain `-`.
func (sc *scanner) name() string {
	start := sc.i
	for !sc.eof() {
		r, size := sc.peek()
		if !isIDCont(r) && r != '-' {
			break
		}
		sc.i += size
	}
	return sc.s[start:sc.i]
}

func (sc *scanner) at(chars string) bool {
	r, _ := sc.peek()
	return r >= 0 && r < 128 && strings.ContainsRune(chars, r)
}

func (sc *scanner) nameEnd(chars string) bool {
	r, _ := sc.peek()
	return sc.at(chars) || isLineEndingOrSpace(r) || isUnicodeWhitespace(r)
}

const (
	expectNameStart = "a character that can start a name, such as a letter, `$`, or `_`"
	expectAttrStart = "a character that can start an attribute name, such as a letter, `$`, or `_`; whitespace before attributes; or the end of the tag"
	expectNameChar  = "a name character such as letters, digits, `$`, or `_`; whitespace before attributes; or the end of the tag"
	noteLink        = " (note: to create a link in MDX, use `[text](url)`)"
	noteComment     = " (note: JS comments in JSX tags are not supported in MDX)"
)

// scanTag scans a JSX tag at sc.i (a `<`). ok=false with a nil error means
// the text is not a tag.
func (sc *scanner) scanTag() (tag *jsxTag, ok bool, err error) {
	tag = &jsxTag{start: sc.off + sc.i}
	sc.i++
	r, _ := sc.peek()
	if r < 0 || isLineEndingOrSpace(r) {
		return nil, false, nil
	}
	sc.ws()
	r, _ = sc.peek()
	switch {
	case r == '/':
		tag.close = true
		sc.i++
		sc.ws()
		r, _ = sc.peek()
		if r == '>' {
			return sc.tagEnd(tag)
		}
		if !sc.idStart() {
			note := ""
			if r == '*' || r == '/' {
				note = noteComment
			}
			return nil, false, crash(r, "before name", expectNameStart+note)
		}
	case r == '>':
		return sc.tagEnd(tag)
	case !sc.idStart():
		note := ""
		if r == '!' {
			note = " (note: to create a comment in MDX, use `{/* text */}`)"
		}
		return nil, false, crash(r, "before name", expectNameStart+note)
	}
	// primaryName
	tag.name = sc.name()
	if !sc.nameEnd(".:/>{") {
		r, _ := sc.peek()
		note := ""
		if r == '@' {
			note = noteLink
		}
		return nil, false, crash(r, "in name", expectNameChar+note)
	}
	sc.ws()
	switch {
	case sc.at("."):
		for sc.at(".") {
			sc.i++
			sc.ws()
			if !sc.idStart() {
				r, _ := sc.peek()
				return nil, false, crash(r, "before member name", expectAttrStart)
			}
			tag.name += "." + sc.name()
			if !sc.nameEnd("./>{") {
				r, _ := sc.peek()
				note := ""
				if r == '@' {
					note = noteLink
				}
				return nil, false, crash(r, "in member name", expectNameChar+note)
			}
			sc.ws()
		}
		if !sc.at("/>{") && !sc.idStart() {
			r, _ := sc.peek()
			return nil, false, crash(r, "after member name", expectAttrStart)
		}
	case sc.at(":"):
		sc.i++
		sc.ws()
		if !sc.idStart() {
			r, _ := sc.peek()
			note := ""
			if r == '+' || (r > 46 && r < 58) {
				note = noteLink
			}
			return nil, false, crash(r, "before local name", expectNameStart+note)
		}
		tag.name += ":" + sc.name()
		if !sc.nameEnd("/>{") {
			r, _ := sc.peek()
			return nil, false, crash(r, "in local name", expectNameChar)
		}
		sc.ws()
		if !sc.at("/>{") && !sc.idStart() {
			r, _ := sc.peek()
			return nil, false, crash(r, "after local name", expectAttrStart)
		}
	case sc.at("/>{") || sc.idStart():
	default:
		r, _ := sc.peek()
		return nil, false, crash(r, "after name", expectAttrStart)
	}
	return sc.attributes(tag)
}

const (
	expectAttrInit     = "a character that can start an attribute name, such as a letter, `$`, or `_`; `=` to initialize a value; or the end of the tag"
	expectAttrNameChar = "an attribute name character such as letters, digits, `$`, or `_`; `=` to initialize a value; whitespace before attributes; or the end of the tag"
)

func (sc *scanner) attributes(tag *jsxTag) (*jsxTag, bool, error) {
	for {
		r, _ := sc.peek()
		switch {
		case r == '/':
			sc.i++
			tag.selfClosing = true
			sc.ws()
			r, _ := sc.peek()
			if r != '>' {
				note := ""
				if r == '*' || r == '/' {
					note = noteComment
				}
				return nil, false, crash(r, "after self-closing slash", "`>` to end the tag"+note)
			}
			return sc.tagEnd(tag)
		case r == '>':
			return sc.tagEnd(tag)
		case r == '{':
			node, err := sc.scanExpression(true, false)
			if err != nil {
				return nil, false, err
			}
			_ = node
			tag.attrs = append(tag.attrs, jsxAttr{spread: true})
			sc.ws()
		case sc.idStart():
			attr := jsxAttr{name: sc.name()}
			if !sc.nameEnd("/:=>{") {
				r, _ := sc.peek()
				return nil, false, crash(r, "in attribute name", expectAttrNameChar)
			}
			sc.ws()
			if sc.at(":") {
				sc.i++
				sc.ws()
				if !sc.idStart() {
					r, _ := sc.peek()
					return nil, false, crash(r, "before local attribute name", expectAttrInit)
				}
				attr.name += ":" + sc.name()
				if !sc.nameEnd("/=>{") {
					r, _ := sc.peek()
					return nil, false, crash(r, "in local attribute name", expectAttrNameChar)
				}
				sc.ws()
				if !sc.at("=/>{") && !sc.idStart() {
					r, _ := sc.peek()
					return nil, false, crash(r, "after local attribute name", expectAttrInit)
				}
			} else if !sc.at("=/>{") && !sc.idStart() {
				r, _ := sc.peek()
				return nil, false, crash(r, "after attribute name", expectAttrInit)
			}
			if sc.at("=") {
				sc.i++
				sc.ws()
				if err := sc.attributeValue(&attr); err != nil {
					return nil, false, err
				}
			}
			tag.attrs = append(tag.attrs, attr)
			sc.ws()
		default:
			return nil, false, crash(r, "before attribute name", expectAttrStart)
		}
	}
}

func (sc *scanner) attributeValue(attr *jsxAttr) error {
	r, _ := sc.peek()
	switch r {
	case '"', '\'':
		quote := r
		sc.i++
		var b strings.Builder
		for {
			r, size := sc.peek()
			switch {
			case r < 0:
				return crash(r, "in attribute value", "a corresponding closing quote `"+string(quote)+"`")
			case r == quote:
				sc.i++
				attr.hasValue, attr.value = true, decodeEntities(b.String())
				return nil
			case isLineEnding(r):
				b.WriteString(sc.s[sc.i : sc.i+size])
				sc.ws()
			default:
				b.WriteString(sc.s[sc.i : sc.i+size])
				sc.i += size
			}
		}
	case '{':
		node, err := sc.scanExpression(false, false)
		if err != nil {
			return err
		}
		attr.expr = node
		return nil
	}
	note := ""
	if r == '<' {
		note = " (note: to use an element or fragment as a prop value in MDX, use `{<element />}`)"
	}
	return crash(r, "before attribute value", "a character that can start an attribute value, such as `\"`, `'`, or `{`"+note)
}

func (sc *scanner) tagEnd(tag *jsxTag) (*jsxTag, bool, error) {
	sc.i++
	tag.end = sc.off + sc.i
	return tag, true, nil
}

var entityPattern = regexp.MustCompile(`&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);`)

// decodeEntities decodes terminated character references only, like
// parse-entities with nonTerminated: false.
func decodeEntities(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	return entityPattern.ReplaceAllStringFunc(s, func(ref string) string {
		return html.UnescapeString(ref)
	})
}

var (
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineComment  = regexp.MustCompile(`//[^\r\n]*(\r\n|\n|\r)`)
)

// emptyExpression mirrors events-to-acorn's empty(): only whitespace and
// comments.
func emptyExpression(s string) bool {
	s = lineComment.ReplaceAllString(blockComment.ReplaceAllString(s, ""), "")
	for _, r := range s {
		if !isUnicodeWhitespace(r) {
			return false
		}
	}
	return true
}

// scanExpression scans `{...}` at sc.i. Like micromark, it tries acorn at
// every `}` and keeps going until one parses, crashing at the end of input.
// The returned node is the expression for attribute values.
func (sc *scanner) scanExpression(spread, allowEmpty bool) (*jsNode, error) {
	sc.i++
	var src strings.Builder
	var lastCrash error
	for {
		r, size := sc.peek()
		switch {
		case r < 0:
			if lastCrash != nil {
				return nil, lastCrash
			}
			return nil, &syntaxError{msg: "Unexpected end of file in expression, expected a corresponding closing brace for `{`"}
		case isLineEnding(r):
			src.WriteString(sc.s[sc.i : sc.i+size])
			sc.i += size
			for n := 0; n < 2 && !sc.eof() && isMarkdownSpace(rune(sc.s[sc.i])); n++ {
				sc.i++
			}
		case r == '}':
			node, err := parseMdxExpression(src.String(), spread, allowEmpty)
			if err == nil {
				sc.i++
				return node, nil
			}
			if _, fatal := err.(*syntaxError); fatal {
				return nil, err
			}
			lastCrash = &syntaxError{msg: "Could not parse expression with acorn"}
			src.WriteByte('}')
			sc.i++
		default:
			src.WriteString(sc.s[sc.i : sc.i+size])
			sc.i += size
		}
	}
}

type acornError struct{}

func (acornError) Error() string { return "acorn" }

// parseMdxExpression is mdxExpressionParse plus eventsToAcorn. A
// *syntaxError is thrown immediately; acornError lets scanning continue.
func parseMdxExpression(source string, spread, allowEmpty bool) (*jsNode, error) {
	value := source
	if spread {
		value = "({" + source + "})"
	}
	if emptyExpression(source) {
		if !allowEmpty {
			return nil, &syntaxError{msg: "Unexpected empty expression"}
		}
		if parseEmptyProgram(value) != nil {
			return nil, acornError{}
		}
		return nil, nil
	}
	node, end, err := parseExpressionAt(value)
	if err != nil {
		return nil, acornError{}
	}
	tail := value[end:]
	if spread {
		tail = strings.TrimSuffix(tail, "})")
	}
	if !emptyExpression(tail) {
		return nil, acornError{}
	}
	if spread {
		if node.Type != "ObjectExpression" {
			return nil, &syntaxError{msg: "Unexpected `ExpressionStatement` in code: expected an object spread (`{...spread}`)"}
		}
		if len(node.Props) > 1 {
			return nil, &syntaxError{msg: "Unexpected extra content in spread: only a single spread is supported"}
		}
		if len(node.Props) == 1 && node.Props[0].Type != "SpreadElement" {
			return nil, &syntaxError{msg: "Unexpected `" + node.Props[0].Type + "` in code: only spread elements are supported"}
		}
	}
	return node, nil
}

// flowItem is one tag or expression on a flow line.
type flowItem struct {
	tag        *jsxTag
	start, end int
}

// scanFlow scans a line of flow tags and expressions at sc.i, mirroring
// jsxFlow and mdxFlowExpression: after a tag may come another tag, an
// expression, or the end of the line; after an expression, a tag or the end.
func (sc *scanner) scanFlow() (items []flowItem, ok bool, err error) {
	afterExpression := false
	for {
		r, _ := sc.peek()
		start := sc.off + sc.i
		switch {
		case r == '<':
			tag, ok, err := sc.scanTag()
			if err != nil || !ok {
				return nil, false, err
			}
			items = append(items, flowItem{tag: tag, start: start, end: tag.end})
			afterExpression = false
		case r == '{' && !afterExpression:
			if _, err := sc.scanExpression(false, true); err != nil {
				return nil, false, err
			}
			items = append(items, flowItem{start: start, end: sc.off + sc.i})
			afterExpression = true
		default:
			return nil, false, nil
		}
		for !sc.eof() && isMarkdownSpace(rune(sc.s[sc.i])) {
			sc.i++
		}
		r, _ = sc.peek()
		if r < 0 || isLineEnding(r) {
			return items, true, nil
		}
	}
}
