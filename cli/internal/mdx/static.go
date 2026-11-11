package mdx

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

// Plans are data, not programs: attribute expressions are parsed as
// JavaScript, but only literal shapes are accepted and nothing is evaluated.
// The parser covers the expression grammar well enough to name what was
// found ("CallExpression is not a static value"); anything it cannot parse
// is a syntax error that makes the whole document unparseable.

// undefinedValue is JavaScript's undefined, which a prop may be set to.
type undefinedValue struct{}

var forbiddenKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

// staticError is a well-formed expression that is not a static value.
type staticError struct{ msg string }

func (e *staticError) Error() string { return e.msg }

// syntaxError is an expression that does not parse.
type syntaxError struct{ msg string }

func (e *syntaxError) Error() string { return e.msg }

// node is a parsed expression: either a static value or the reason it is
// not one. Errors are kept on the node rather than raised immediately, so the
// outermost construct is the one reported, as when evaluating an AST.
type node struct {
	value any
	err   *staticError
}

func nonStatic(format string, args ...any) node {
	return node{err: &staticError{fmt.Sprintf(format, args...)}}
}

type exprParser struct {
	src string
	pos int
}

func (p *exprParser) fail(format string, args ...any) {
	panic(&syntaxError{fmt.Sprintf(format, args...)})
}

func (p *exprParser) eof() bool { return p.pos >= len(p.src) }

func (p *exprParser) peekByte() byte {
	if p.eof() {
		return 0
	}
	return p.src[p.pos]
}

// skipSpace skips whitespace and comments.
func (p *exprParser) skipSpace() {
	for !p.eof() {
		r, size := utf8.DecodeRuneInString(p.src[p.pos:])
		switch {
		case unicode.IsSpace(r) || r == 0xFEFF:
			p.pos += size
		case strings.HasPrefix(p.src[p.pos:], "//"):
			end := strings.IndexAny(p.src[p.pos:], "\n\r  ")
			if end < 0 {
				p.pos = len(p.src)
			} else {
				p.pos += end
			}
		case strings.HasPrefix(p.src[p.pos:], "/*"):
			end := strings.Index(p.src[p.pos+2:], "*/")
			if end < 0 {
				p.fail("Unterminated comment")
			}
			p.pos += end + 4
		default:
			return
		}
	}
}

func (p *exprParser) at(s string) bool {
	p.skipSpace()
	return strings.HasPrefix(p.src[p.pos:], s)
}

func (p *exprParser) eat(s string) bool {
	if p.at(s) {
		p.pos += len(s)
		return true
	}
	return false
}

func (p *exprParser) expect(s string) {
	if !p.eat(s) {
		p.fail("Expected `%s`", s)
	}
}

func isIdentStart(r rune) bool { return r == '$' || r == '_' || unicode.IsLetter(r) }
func isIdentPart(r rune) bool {
	return isIdentStart(r) || unicode.IsDigit(r) || r == '‌' || r == '‍'
}

// atWord reports whether the next token is the keyword or identifier w.
func (p *exprParser) atWord(w string) bool {
	if !p.at(w) {
		return false
	}
	r, _ := utf8.DecodeRuneInString(p.src[p.pos+len(w):])
	return p.pos+len(w) == len(p.src) || !isIdentPart(r)
}

func (p *exprParser) ident() string {
	p.skipSpace()
	start := p.pos
	for !p.eof() {
		r, size := utf8.DecodeRuneInString(p.src[p.pos:])
		if (p.pos == start && !isIdentStart(r)) || (p.pos > start && !isIdentPart(r)) {
			break
		}
		p.pos += size
	}
	if p.pos == start {
		p.fail("Unexpected token")
	}
	return p.src[start:p.pos]
}

// parseProgram parses the body of an attribute expression. ok is false when
// the program is not exactly one expression statement.
func parseProgram(src string) (n node, ok bool, err error) {
	p := &exprParser{src: src}
	defer func() {
		if r := recover(); r != nil {
			se, isSyntax := r.(*syntaxError)
			if !isSyntax {
				panic(r)
			}
			err = se
		}
	}()
	p.skipSpace()
	if p.eof() {
		return node{}, false, nil
	}
	n = p.expression()
	p.eat(";")
	p.skipSpace()
	if !p.eof() {
		// A second statement: still valid JavaScript, but not one value.
		p.expression()
		return node{}, false, nil
	}
	return n, true, nil
}

// expression parses a comma-separated sequence.
func (p *exprParser) expression() node {
	n := p.assignment()
	if p.at(",") {
		for p.eat(",") {
			p.assignment()
		}
		return nonStatic("SequenceExpression is not a static value")
	}
	return n
}

var assignOps = []string{">>>=", "**=", "<<=", ">>=", "&&=", "||=", "??=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="}

func (p *exprParser) assignment() node {
	n := p.conditional()
	for _, op := range assignOps {
		if p.eat(op) {
			p.assignment()
			return nonStatic("AssignmentExpression is not a static value")
		}
	}
	if p.at("=") && !p.at("==") && !p.at("=>") {
		p.pos++
		p.assignment()
		return nonStatic("AssignmentExpression is not a static value")
	}
	return n
}

func (p *exprParser) conditional() node {
	n := p.binary()
	if p.at("?") && !p.at("??") && !p.at("?.") {
		p.pos++
		p.assignment()
		p.expect(":")
		p.assignment()
		return nonStatic("ConditionalExpression is not a static value")
	}
	return n
}

var binaryOps = []string{"===", "!==", "**", "==", "!=", "<=", ">=", "<<", ">>>", ">>", "&&", "||", "??", "+", "-", "*", "/", "%", "<", ">", "&", "|", "^"}

func (p *exprParser) binaryOp() (string, bool) {
	p.skipSpace()
	for _, op := range binaryOps {
		if strings.HasPrefix(p.src[p.pos:], op) {
			// Leave compound assignment operators to assignment().
			if rest := p.src[p.pos+len(op):]; strings.HasPrefix(rest, "=") && op != "==" && op != "!=" && op != "<=" && op != ">=" && op != "===" && op != "!==" {
				return "", false
			}
			return op, true
		}
	}
	for _, w := range []string{"instanceof", "in"} {
		if p.atWord(w) {
			return w, true
		}
	}
	return "", false
}

func (p *exprParser) binary() node {
	n := p.unary()
	found := ""
	for {
		op, ok := p.binaryOp()
		if !ok {
			break
		}
		if found == "" {
			found = op
		}
		p.pos += len(op)
		p.unary()
	}
	switch found {
	case "":
		return n
	case "&&", "||", "??":
		return nonStatic("LogicalExpression is not a static value")
	}
	return nonStatic("BinaryExpression is not a static value")
}

func (p *exprParser) unary() node {
	for _, op := range []string{"++", "--"} {
		if p.eat(op) {
			p.unary()
			return nonStatic("UpdateExpression is not a static value")
		}
	}
	for _, op := range []string{"-", "+", "!", "~"} {
		if p.eat(op) {
			start := p.pos
			arg := p.unary()
			if op == "-" || op == "+" {
				if f, ok := arg.value.(float64); ok && arg.err == nil && p.isNumberLiteral(start) {
					if op == "-" {
						f = -f
					}
					return node{value: f}
				}
			}
			return nonStatic("operator %s is not supported", op)
		}
	}
	for _, w := range []string{"typeof", "void", "delete"} {
		if p.atWord(w) {
			p.pos += len(w)
			p.unary()
			return nonStatic("operator %s is not supported", w)
		}
	}
	if p.atWord("await") {
		p.pos += len("await")
		p.unary()
		return nonStatic("AwaitExpression is not a static value")
	}
	n := p.postfix()
	if p.at("++") || p.at("--") {
		p.pos += 2
		return nonStatic("UpdateExpression is not a static value")
	}
	return n
}

// isNumberLiteral reports whether the source from start to the current
// position is a single number literal, possibly parenthesized.
func (p *exprParser) isNumberLiteral(start int) bool {
	text := strings.TrimSpace(p.src[start:p.pos])
	for strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")") {
		text = strings.TrimSpace(text[1 : len(text)-1])
	}
	return text != "" && (text[0] >= '0' && text[0] <= '9' || text[0] == '.')
}

func (p *exprParser) postfix() node {
	n := p.primary()
	for {
		switch {
		case p.at("?.("):
			p.pos += 2
			p.arguments()
			n = nonStatic("ChainExpression is not a static value")
		case p.at("?.["):
			p.pos += 2
			p.computedMember()
			n = nonStatic("ChainExpression is not a static value")
		case p.at("?."):
			p.pos += 2
			p.ident()
			n = nonStatic("ChainExpression is not a static value")
		case p.at("."):
			p.pos++
			if p.eat("#") {
				p.ident()
			} else {
				p.ident()
			}
			n = nonStatic("MemberExpression is not a static value")
		case p.at("["):
			p.computedMember()
			n = nonStatic("MemberExpression is not a static value")
		case p.at("("):
			p.arguments()
			n = nonStatic("CallExpression is not a static value")
		case p.at("`"):
			p.template()
			n = nonStatic("TaggedTemplateExpression is not a static value")
		default:
			return n
		}
	}
}

func (p *exprParser) computedMember() {
	p.expect("[")
	p.expression()
	p.expect("]")
}

func (p *exprParser) arguments() {
	p.expect("(")
	for !p.at(")") {
		p.eat("...")
		p.assignment()
		if !p.eat(",") {
			break
		}
	}
	p.expect(")")
}

func (p *exprParser) primary() node {
	p.skipSpace()
	if p.eof() {
		p.fail("Unexpected end of expression")
	}
	c := p.src[p.pos]
	switch {
	case c == '"' || c == '\'':
		return node{value: p.stringLiteral()}
	case c == '`':
		return p.template()
	case c >= '0' && c <= '9' || (c == '.' && p.pos+1 < len(p.src) && p.src[p.pos+1] >= '0' && p.src[p.pos+1] <= '9'):
		return p.number()
	case c == '[':
		return p.array()
	case c == '{':
		return p.object()
	case c == '(':
		return p.parenthesized()
	case c == '/':
		p.regex()
		return nonStatic("regular expressions and bigints are not supported")
	case c == '#':
		p.pos++
		p.ident()
		p.fail("Unexpected private name")
	}
	if p.atWord("function") || p.atWord("async") && p.isAsyncFunction() {
		return p.function()
	}
	if p.atWord("class") {
		p.fail("Class expressions are not supported")
	}
	if p.atWord("new") {
		p.pos += len("new")
		if p.eat(".") {
			p.ident()
			return nonStatic("MetaProperty is not a static value")
		}
		p.postfixNoCall()
		if p.at("(") {
			p.arguments()
		}
		return nonStatic("NewExpression is not a static value")
	}
	name := p.ident()
	if p.at("=>") {
		p.arrowBody()
		return nonStatic("ArrowFunctionExpression is not a static value")
	}
	switch name {
	case "true":
		return node{value: true}
	case "false":
		return node{value: false}
	case "null":
		return node{value: nil}
	case "this":
		return nonStatic("ThisExpression is not a static value")
	case "undefined":
		return node{value: undefinedValue{}}
	case "yield":
		p.fail("Unexpected yield")
	}
	return nonStatic("variables are not supported (found \"%s\")", name)
}

func (p *exprParser) isAsyncFunction() bool {
	save := p.pos
	defer func() { p.pos = save }()
	p.pos += len("async")
	return p.atWord("function")
}

func (p *exprParser) function() node {
	p.eat("async")
	p.skipSpace()
	p.pos += len("function")
	p.eat("*")
	if !p.at("(") {
		p.ident()
	}
	p.skipBalanced('(', ')')
	p.skipBalanced('{', '}')
	return nonStatic("FunctionExpression is not a static value")
}

func (p *exprParser) postfixNoCall() {
	p.primary()
	for {
		switch {
		case p.at("."):
			p.pos++
			p.ident()
		case p.at("["):
			p.computedMember()
		default:
			return
		}
	}
}

func (p *exprParser) arrowBody() {
	p.expect("=>")
	if p.at("{") {
		p.skipBalanced('{', '}')
		return
	}
	p.assignment()
}

func (p *exprParser) parenthesized() node {
	save := p.pos
	// An arrow function's parameter list looks like a parenthesized
	// expression until its "=>".
	p.skipBalanced('(', ')')
	if p.at("=>") {
		p.arrowBody()
		return nonStatic("ArrowFunctionExpression is not a static value")
	}
	p.pos = save
	p.expect("(")
	n := p.expression()
	p.expect(")")
	return n
}

// skipBalanced skips a bracketed group, honoring strings, templates, and
// comments inside it.
func (p *exprParser) skipBalanced(open, close byte) {
	p.skipSpace()
	if p.peekByte() != open {
		p.fail("Expected `%c`", open)
	}
	end, ok := matchBrace(p.src, p.pos, open, close)
	if !ok {
		p.fail("Unexpected end of expression, expected `%c`", close)
	}
	p.pos = end
}

func (p *exprParser) regex() {
	p.pos++ // opening slash
	inClass := false
	for {
		if p.eof() || p.src[p.pos] == '\n' {
			p.fail("Unterminated regular expression")
		}
		c := p.src[p.pos]
		p.pos++
		switch {
		case c == '\\':
			p.pos++
		case c == '[':
			inClass = true
		case c == ']':
			inClass = false
		case c == '/' && !inClass:
			for !p.eof() {
				r, size := utf8.DecodeRuneInString(p.src[p.pos:])
				if !isIdentPart(r) {
					break
				}
				p.pos += size
			}
			return
		}
	}
}

func (p *exprParser) number() node {
	start := p.pos
	src := p.src
	isDigit := func(c byte, base int) bool {
		switch base {
		case 16:
			return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
		case 8:
			return c >= '0' && c <= '7'
		case 2:
			return c == '0' || c == '1'
		}
		return c >= '0' && c <= '9'
	}
	digits := func(base int) {
		for p.pos < len(src) && (isDigit(src[p.pos], base) || src[p.pos] == '_') {
			p.pos++
		}
	}
	base := 10
	if src[p.pos] == '0' && p.pos+1 < len(src) {
		switch src[p.pos+1] | 0x20 {
		case 'x':
			base = 16
		case 'o':
			base = 8
		case 'b':
			base = 2
		}
	}
	if base != 10 {
		p.pos += 2
		digits(base)
	} else {
		digits(10)
		if p.pos < len(src) && src[p.pos] == '.' {
			p.pos++
			digits(10)
		}
		if p.pos < len(src) && src[p.pos]|0x20 == 'e' {
			p.pos++
			if p.pos < len(src) && (src[p.pos] == '+' || src[p.pos] == '-') {
				p.pos++
			}
			digits(10)
		}
	}
	text := strings.ReplaceAll(src[start:p.pos], "_", "")
	if p.pos < len(src) && src[p.pos] == 'n' {
		p.pos++
		return nonStatic("regular expressions and bigints are not supported")
	}
	if r, _ := utf8.DecodeRuneInString(src[p.pos:]); p.pos < len(src) && isIdentStart(r) {
		p.fail("Identifier directly after number")
	}
	if base != 10 {
		u, err := strconv.ParseUint(text[2:], base, 64)
		if err != nil {
			p.fail("Invalid number")
		}
		return node{value: float64(u)}
	}
	f, err := strconv.ParseFloat(text, 64)
	if err != nil && !strings.Contains(err.Error(), "range") {
		p.fail("Invalid number")
	}
	return node{value: f}
}

// readEscape decodes the escape sequence after a backslash.
func (p *exprParser) readEscape(b *strings.Builder) {
	if p.eof() {
		p.fail("Unterminated string")
	}
	c := p.src[p.pos]
	p.pos++
	switch c {
	case 'n':
		b.WriteByte('\n')
	case 't':
		b.WriteByte('\t')
	case 'r':
		b.WriteByte('\r')
	case 'b':
		b.WriteByte('\b')
	case 'f':
		b.WriteByte('\f')
	case 'v':
		b.WriteByte('\v')
	case '0':
		b.WriteByte(0)
	case '\r':
		if p.peekByte() == '\n' {
			p.pos++
		}
	case '\n':
	case 'x':
		if p.pos+2 > len(p.src) {
			p.fail("Bad character escape sequence")
		}
		v, err := strconv.ParseUint(p.src[p.pos:p.pos+2], 16, 8)
		if err != nil {
			p.fail("Bad character escape sequence")
		}
		p.pos += 2
		b.WriteRune(rune(v))
	case 'u':
		var hexText string
		if p.peekByte() == '{' {
			end := strings.IndexByte(p.src[p.pos:], '}')
			if end < 0 {
				p.fail("Bad character escape sequence")
			}
			hexText = p.src[p.pos+1 : p.pos+end]
			p.pos += end + 1
		} else {
			if p.pos+4 > len(p.src) {
				p.fail("Bad character escape sequence")
			}
			hexText = p.src[p.pos : p.pos+4]
			p.pos += 4
		}
		v, err := strconv.ParseUint(hexText, 16, 32)
		if err != nil || v > unicode.MaxRune {
			p.fail("Bad character escape sequence")
		}
		b.WriteRune(rune(v))
	default:
		p.pos--
		r, size := utf8.DecodeRuneInString(p.src[p.pos:])
		p.pos += size
		b.WriteRune(r)
	}
}

func (p *exprParser) stringLiteral() string {
	quote := p.src[p.pos]
	p.pos++
	var b strings.Builder
	for {
		if p.eof() || p.src[p.pos] == '\n' || p.src[p.pos] == '\r' {
			p.fail("Unterminated string constant")
		}
		c := p.src[p.pos]
		p.pos++
		switch c {
		case quote:
			return b.String()
		case '\\':
			p.readEscape(&b)
		default:
			b.WriteByte(c)
		}
	}
}

func (p *exprParser) template() node {
	p.skipSpace()
	p.pos++ // opening backtick
	var b strings.Builder
	interpolated := false
	for {
		if p.eof() {
			p.fail("Unterminated template")
		}
		c := p.src[p.pos]
		switch {
		case c == '`':
			p.pos++
			if interpolated {
				return nonStatic("template literals cannot interpolate ${...}")
			}
			return node{value: b.String()}
		case c == '\\':
			p.pos++
			p.readEscape(&b)
		case c == '$' && p.pos+1 < len(p.src) && p.src[p.pos+1] == '{':
			interpolated = true
			p.pos += 2
			p.expression()
			p.expect("}")
		case c == '\r':
			// Template literals normalize line endings to \n.
			p.pos++
			if p.peekByte() == '\n' {
				p.pos++
			}
			b.WriteByte('\n')
		default:
			p.pos++
			b.WriteByte(c)
		}
	}
}

func (p *exprParser) array() node {
	p.expect("[")
	var values []any
	var err *staticError
	note := func(e *staticError) {
		if err == nil {
			err = e
		}
	}
	for !p.at("]") {
		if p.at(",") {
			p.pos++
			note(&staticError{"arrays cannot contain holes or spreads"})
			continue
		}
		if p.eat("...") {
			p.assignment()
			note(&staticError{"arrays cannot contain holes or spreads"})
		} else {
			n := p.assignment()
			if n.err != nil {
				note(n.err)
			}
			values = append(values, n.value)
		}
		if !p.eat(",") {
			break
		}
	}
	p.expect("]")
	if err != nil {
		return node{err: err}
	}
	if values == nil {
		values = []any{}
	}
	return node{value: values}
}

func (p *exprParser) object() node {
	p.expect("{")
	result := ordered.New()
	var err *staticError
	note := func(e *staticError) {
		if err == nil {
			err = e
		}
	}
	plain := &staticError{"objects may only contain plain key: value pairs"}
	for !p.at("}") {
		switch {
		case p.eat("..."):
			p.assignment()
			note(plain)
		case p.at("["):
			p.computedMember()
			p.propertyRest()
			note(plain)
		default:
			key, isName := p.propertyKey()
			if isName && (key == "get" || key == "set" || key == "async") && !p.at(":") && !p.at("(") && !p.at(",") && !p.at("}") {
				p.propertyKey()
				p.propertyRest()
				note(plain)
				break
			}
			switch {
			case p.eat(":"):
				value := p.assignment()
				if forbiddenKeys[key] {
					note(&staticError{fmt.Sprintf("object key \"%s\" is not allowed", key)})
				} else if value.err != nil {
					note(value.err)
				} else {
					result.Set(key, value.value)
				}
			case p.at("("):
				p.propertyRest()
				note(plain)
			case isName && (p.at(",") || p.at("}") || p.at("=")):
				// Shorthand {name} reads a variable.
				if p.eat("=") {
					p.assignment()
				}
				if forbiddenKeys[key] {
					note(&staticError{fmt.Sprintf("object key \"%s\" is not allowed", key)})
				} else {
					note(&staticError{fmt.Sprintf("variables are not supported (found \"%s\")", key)})
				}
			default:
				p.fail("Unexpected token in object")
			}
		}
		if !p.eat(",") {
			break
		}
	}
	p.expect("}")
	if err != nil {
		return node{err: err}
	}
	return node{value: result}
}

// propertyKey reads an object key: a name, string, or number.
func (p *exprParser) propertyKey() (key string, isName bool) {
	p.skipSpace()
	switch c := p.peekByte(); {
	case c == '"' || c == '\'':
		return p.stringLiteral(), false
	case c >= '0' && c <= '9' || c == '.':
		n := p.number()
		if n.err != nil {
			return "", false
		}
		return jsString(n.value), false
	case c == '*':
		p.pos++
		return p.ident(), false
	}
	return p.ident(), true
}

// propertyRest skips a method's parameters and body.
func (p *exprParser) propertyRest() {
	if p.eat(":") {
		p.assignment()
		return
	}
	p.skipBalanced('(', ')')
	p.skipBalanced('{', '}')
}

// matchBrace returns the index just past the bracket that closes the one at
// start, skipping strings, template literals, and comments.
func matchBrace(src string, start int, open, close byte) (int, bool) {
	depth := 0
	i := start
	for i < len(src) {
		c := src[i]
		switch {
		case c == '"' || c == '\'':
			i++
			for i < len(src) && src[i] != c && src[i] != '\n' {
				if src[i] == '\\' {
					i++
				}
				i++
			}
		case c == '`':
			end, ok := skipTemplate(src, i)
			if !ok {
				return 0, false
			}
			i = end - 1
		case strings.HasPrefix(src[i:], "//"):
			end := strings.IndexByte(src[i:], '\n')
			if end < 0 {
				return 0, false
			}
			i += end
		case strings.HasPrefix(src[i:], "/*"):
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				return 0, false
			}
			i += end + 3
		case c == open:
			depth++
		case c == close:
			depth--
			if depth == 0 {
				return i + 1, true
			}
		}
		i++
	}
	return 0, false
}

func skipTemplate(src string, start int) (int, bool) {
	i := start + 1
	for i < len(src) {
		switch {
		case src[i] == '\\':
			i += 2
		case src[i] == '`':
			return i + 1, true
		case strings.HasPrefix(src[i:], "${"):
			end, ok := matchBrace(src, i+1, '{', '}')
			if !ok {
				return 0, false
			}
			i = end
		default:
			i++
		}
	}
	return 0, false
}

// jsString formats a static value the way JavaScript's String() does.
func jsString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case float64:
		switch {
		case math.IsNaN(t):
			return "NaN"
		case math.IsInf(t, 1):
			return "Infinity"
		case math.IsInf(t, -1):
			return "-Infinity"
		case t == math.Trunc(t) && math.Abs(t) < 1e21:
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	}
	return fmt.Sprint(v)
}
