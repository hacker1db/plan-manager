package mdxrender

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// A small ES2024 (module, strict, JSX) parser standing in for acorn. MDX uses
// acorn only to find where `{...}` expressions and import/export blocks end
// and whether they are valid; the props evaluator then reads literal nodes.
// Expressions are parsed fully. Function and class bodies are skipped by
// balancing brackets, since they are never static values.

type jsNode struct {
	Type     string
	Value    value // Literal
	Regex    bool
	Bigint   bool
	Name     string   // Identifier
	Quasis   []string // TemplateLiteral cooked strings
	Exprs    []*jsNode
	Elements []*jsNode // ArrayExpression; nil is a hole
	Props    []*jsProp // ObjectExpression
	Operator string
	Argument *jsNode
	start    int
	end      int
	paren    bool
	parens   int  // nesting depth of parentheses around this node
	cover    bool // object literal with `a = 1` shorthand, valid only as a pattern
}

type jsProp struct {
	Type     string // Property or SpreadElement
	Kind     string // init, get, set
	Computed bool
	Method   bool
	Key      *jsNode
	Value    *jsNode
	start    int
}

type jsError struct {
	msg   string
	atEnd bool
}

type tokKind int

const (
	tEOF tokKind = iota
	tName
	tNum
	tString
	tRegex
	tPunct
	tPrivate
)

type token struct {
	kind      tokKind
	value     string // name, punctuator, or raw
	str       string // cooked string value
	num       float64
	bigint    bool
	escaped   bool // identifier contained a \u escape
	start     int
	end       int
	nlBefore  bool
	legacyOct bool
}

type jsParser struct {
	src          string
	pos          int
	tok          token
	prevEnd      int
	lastTemplate *jsNode
	scope        *moduleScope
}

func (p *jsParser) fail(msg string) {
	panic(&jsError{msg: msg, atEnd: p.pos >= len(p.src)})
}

func parseJS(src string, fn func(p *jsParser)) (err *jsError) {
	p := &jsParser{src: src}
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(*jsError)
			if !ok {
				panic(r)
			}
			err = e
		}
	}()
	fn(p)
	return nil
}

// parseExpressionAt mirrors acorn.parseExpressionAt(src, 0): it returns the
// expression and the offset where it ends.
func parseExpressionAt(src string) (node *jsNode, end int, err *jsError) {
	err = parseJS(src, func(p *jsParser) {
		p.next(true)
		node = p.parseExpression()
		end = node.end
	})
	return node, end, err
}

// parseProgram validates a module that may only contain comments.
func parseEmptyProgram(src string) *jsError {
	return parseJS(src, func(p *jsParser) {
		p.next(true)
		if p.tok.kind != tEOF {
			p.fail("Unexpected token")
		}
	})
}

// ---------- characters ----------

func isIDStart(r rune) bool {
	return r == '$' || r == '_' || (r < 128 && (r|0x20 >= 'a' && r|0x20 <= 'z')) ||
		(r >= 128 && (unicode.IsLetter(r) || unicode.Is(unicode.Nl, r) || unicode.Is(unicode.Other_ID_Start, r)) &&
			!unicode.Is(unicode.Pattern_Syntax, r) && !unicode.Is(unicode.Pattern_White_Space, r))
}

func isIDCont(r rune) bool {
	return isIDStart(r) || (r >= '0' && r <= '9') || r == 0x200c || r == 0x200d ||
		(r >= 128 && (unicode.In(r, unicode.Mn, unicode.Mc, unicode.Nd, unicode.Pc) || unicode.Is(unicode.Other_ID_Continue, r)))
}

func isJSLineTerminator(r rune) bool {
	return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029
}

func isJSSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\v' || r == '\f' || r == 0xa0 || r == 0xfeff || (r > 127 && unicode.Is(unicode.Zs, r))
}

func (p *jsParser) peekRune(at int) (rune, int) {
	if at >= len(p.src) {
		return -1, 0
	}
	return utf8.DecodeRuneInString(p.src[at:])
}

// skipSpace skips whitespace and comments, reporting whether it crossed a
// line terminator.
func (p *jsParser) skipSpace() bool {
	nl := false
	for p.pos < len(p.src) {
		r, size := p.peekRune(p.pos)
		switch {
		case isJSLineTerminator(r):
			nl = true
			p.pos += size
		case isJSSpace(r):
			p.pos += size
		case r == '/' && strings.HasPrefix(p.src[p.pos:], "//"):
			for p.pos < len(p.src) {
				r, size := p.peekRune(p.pos)
				if isJSLineTerminator(r) {
					break
				}
				p.pos += size
			}
		case r == '/' && strings.HasPrefix(p.src[p.pos:], "/*"):
			end := strings.Index(p.src[p.pos+2:], "*/")
			if end < 0 {
				p.pos = len(p.src)
				p.fail("Unterminated comment")
			}
			comment := p.src[p.pos+2 : p.pos+2+end]
			if strings.ContainsAny(comment, "\n\r  ") {
				nl = true
			}
			p.pos += end + 4
		default:
			return nl
		}
	}
	return nl
}

var punctuators = []string{
	">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
	"=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=",
	"/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
}

// next reads the next token. exprStart says whether a `/` begins a regular
// expression rather than a division.
func (p *jsParser) next(exprStart bool) {
	nl := p.skipSpace()
	start := p.pos
	p.tok = token{start: start, nlBefore: nl}
	if p.pos >= len(p.src) {
		p.tok.kind = tEOF
		p.tok.end = p.pos
		return
	}
	r, size := p.peekRune(p.pos)
	switch {
	case isIDStart(r) || r == '\\':
		name, escaped := p.readWord()
		p.tok.kind, p.tok.value, p.tok.escaped = tName, name, escaped
	case r == '#':
		p.pos++
		r, _ := p.peekRune(p.pos)
		if !isIDStart(r) && r != '\\' {
			p.fail("Unexpected character")
		}
		name, _ := p.readWord()
		p.tok.kind, p.tok.value = tPrivate, name
	case r >= '0' && r <= '9' || (r == '.' && p.pos+1 < len(p.src) && p.src[p.pos+1] >= '0' && p.src[p.pos+1] <= '9'):
		p.readNumber()
	case r == '"' || r == '\'':
		p.tok.kind = tString
		p.tok.str = p.readString(byte(r))
	case r == '/' && exprStart:
		p.readRegex()
	default:
		p.tok.kind = tPunct
		for _, punct := range punctuators {
			if strings.HasPrefix(p.src[p.pos:], punct) {
				if punct == "?." && p.pos+2 < len(p.src) && p.src[p.pos+2] >= '0' && p.src[p.pos+2] <= '9' {
					continue
				}
				p.tok.value = punct
				p.pos += len(punct)
				p.tok.end = p.pos
				return
			}
		}
		if strings.ContainsRune("{}()[];,<>+-*/%&|^!~?:=.@`", r) {
			p.tok.value = string(r)
			p.pos += size
		} else {
			p.fail("Unexpected character")
		}
	}
	p.tok.end = p.pos
}

func (p *jsParser) readWord() (string, bool) {
	var b strings.Builder
	escaped := false
	first := true
	for p.pos < len(p.src) {
		r, size := p.peekRune(p.pos)
		if r == '\\' {
			if !strings.HasPrefix(p.src[p.pos:], "\\u") {
				p.fail("Expecting Unicode escape sequence \\uXXXX")
			}
			p.pos += 2
			r = p.readCodePoint()
			if (first && !isIDStart(r)) || (!first && !isIDCont(r)) {
				p.fail("Invalid Unicode escape")
			}
			escaped = true
			b.WriteRune(r)
			first = false
			continue
		}
		if (first && !isIDStart(r)) || (!first && !isIDCont(r)) {
			break
		}
		b.WriteRune(r)
		p.pos += size
		first = false
	}
	return b.String(), escaped
}

// readCodePoint reads XXXX or {X...} after \u.
func (p *jsParser) readCodePoint() rune {
	if p.pos < len(p.src) && p.src[p.pos] == '{' {
		end := strings.IndexByte(p.src[p.pos:], '}')
		if end < 2 {
			p.fail("Bad character escape sequence")
		}
		n, err := strconv.ParseUint(p.src[p.pos+1:p.pos+end], 16, 32)
		if err != nil || n > 0x10ffff {
			p.fail("Code point out of bounds")
		}
		p.pos += end + 1
		return rune(n)
	}
	if p.pos+4 > len(p.src) {
		p.pos = len(p.src)
		p.fail("Bad character escape sequence")
	}
	n, err := strconv.ParseUint(p.src[p.pos:p.pos+4], 16, 32)
	if err != nil {
		p.fail("Bad character escape sequence")
	}
	p.pos += 4
	return rune(n)
}

func (p *jsParser) digits(valid func(byte) bool) string {
	start := p.pos
	lastSep := true
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '_' {
			if lastSep {
				p.fail("Numeric separators are not allowed here")
			}
			lastSep = true
			p.pos++
			continue
		}
		if !valid(c) {
			break
		}
		lastSep = false
		p.pos++
	}
	if lastSep && p.pos > start {
		p.fail("Numeric separator is not allowed at the last of digits")
	}
	return strings.ReplaceAll(p.src[start:p.pos], "_", "")
}

func isDecimal(c byte) bool { return c >= '0' && c <= '9' }

func (p *jsParser) readNumber() {
	p.tok.kind = tNum
	start := p.pos
	if p.src[p.pos] == '0' && p.pos+1 < len(p.src) && strings.IndexByte("xXoObB", p.src[p.pos+1]) >= 0 {
		radix := map[byte]int{'x': 16, 'o': 8, 'b': 2}[p.src[p.pos+1]|0x20]
		p.pos += 2
		ds := p.digits(func(c byte) bool {
			v, err := strconv.ParseUint(string(c), radix, 8)
			return err == nil && int(v) < radix
		})
		if ds == "" {
			p.fail("Expected number in radix " + strconv.Itoa(radix))
		}
		n, _ := new(big.Int).SetString(ds, radix)
		f, _ := new(big.Float).SetInt(n).Float64()
		p.tok.num = f
		if p.pos < len(p.src) && p.src[p.pos] == 'n' {
			p.pos++
			p.tok.bigint = true
		}
	} else {
		ds := ""
		if p.src[p.pos] != '.' {
			ds = p.digits(isDecimal)
		}
		legacy := len(ds) > 1 && ds[0] == '0'
		if legacy {
			p.fail("Invalid number")
		}
		fraction, exponent := false, false
		if p.pos < len(p.src) && p.src[p.pos] == '.' {
			p.pos++
			p.digits(isDecimal)
			fraction = true
		}
		if p.pos < len(p.src) && (p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
			p.pos++
			if p.pos < len(p.src) && (p.src[p.pos] == '+' || p.src[p.pos] == '-') {
				p.pos++
			}
			if p.digits(isDecimal) == "" {
				p.fail("Invalid number")
			}
			exponent = true
		}
		if p.pos < len(p.src) && p.src[p.pos] == 'n' {
			if fraction || exponent {
				p.fail("Invalid BigInt syntax")
			}
			p.pos++
			p.tok.bigint = true
		}
		f, err := strconv.ParseFloat(strings.ReplaceAll(p.src[start:p.pos], "_", ""), 64)
		if p.tok.bigint {
			f, err = strconv.ParseFloat(ds, 64)
		}
		if err != nil && !math.IsInf(f, 0) {
			p.fail("Invalid number")
		}
		p.tok.num = f
	}
	if r, _ := p.peekRune(p.pos); r >= 0 && (isIDStart(r) || (r >= '0' && r <= '9')) {
		p.fail("Identifier directly after number")
	}
	p.tok.value = p.src[start:p.pos]
}

// readEscape reads one escape after a backslash and appends its UTF-16 units.
// It returns false for escapes that are invalid in strict code.
func (p *jsParser) readEscape(units *[]uint16) bool {
	if p.pos >= len(p.src) {
		p.fail("Unterminated string constant")
	}
	r, size := p.peekRune(p.pos)
	p.pos += size
	switch r {
	case 'n':
		*units = append(*units, '\n')
	case 't':
		*units = append(*units, '\t')
	case 'r':
		*units = append(*units, '\r')
	case 'b':
		*units = append(*units, '\b')
	case 'f':
		*units = append(*units, '\f')
	case 'v':
		*units = append(*units, '\v')
	case '\r':
		if p.pos < len(p.src) && p.src[p.pos] == '\n' {
			p.pos++
		}
	case '\n', 0x2028, 0x2029:
	case 'x':
		if p.pos+2 > len(p.src) {
			return false
		}
		n, err := strconv.ParseUint(p.src[p.pos:p.pos+2], 16, 8)
		if err != nil {
			return false
		}
		p.pos += 2
		*units = append(*units, uint16(n))
	case 'u':
		cp := p.readCodePoint()
		if cp <= 0xffff {
			*units = append(*units, uint16(cp)) // may be half of a surrogate pair
		} else {
			*units = append(*units, utf16.Encode([]rune{cp})...)
		}
	case '0':
		if p.pos < len(p.src) && isDecimal(p.src[p.pos]) {
			return false
		}
		*units = append(*units, 0)
	case '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return false
	default:
		*units = append(*units, utf16.Encode([]rune{r})...)
	}
	return true
}

func decodeUnits(units []uint16) string { return string(utf16.Decode(units)) }

func (p *jsParser) readString(quote byte) string {
	p.pos++
	var units []uint16
	for {
		if p.pos >= len(p.src) {
			p.fail("Unterminated string constant")
		}
		r, size := p.peekRune(p.pos)
		switch {
		case r == rune(quote):
			p.pos++
			return decodeUnits(units)
		case r == '\\':
			p.pos++
			if !p.readEscape(&units) {
				p.fail("Octal literal in strict mode")
			}
		case r == '\n' || r == '\r':
			p.fail("Unterminated string constant")
		default:
			units = append(units, utf16.Encode([]rune{r})...)
			p.pos += size
		}
	}
}

func (p *jsParser) readRegex() {
	p.tok.kind = tRegex
	start := p.pos
	p.pos++
	inClass := false
	for {
		if p.pos >= len(p.src) {
			p.fail("Unterminated regular expression")
		}
		r, size := p.peekRune(p.pos)
		if isJSLineTerminator(r) {
			p.fail("Unterminated regular expression")
		}
		p.pos += size
		if r == '\\' {
			if p.pos < len(p.src) {
				_, size := p.peekRune(p.pos)
				p.pos += size
			}
			continue
		}
		if r == '[' {
			inClass = true
		} else if r == ']' && inClass {
			inClass = false
		} else if r == '/' && !inClass {
			break
		}
	}
	flags, _ := p.readWord()
	for i, f := range flags {
		if !strings.ContainsRune("dgimsuyv", f) || strings.ContainsRune(flags[i+1:], f) {
			p.fail("Invalid regular expression flag")
		}
	}
	p.tok.value = p.src[start:p.pos]
}

// ---------- expressions ----------

var reservedWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await") {
		reservedWords[w] = true
	}
}

func (p *jsParser) is(punct string) bool { return p.tok.kind == tPunct && p.tok.value == punct }

func (p *jsParser) isName(name string) bool {
	return p.tok.kind == tName && p.tok.value == name && !p.tok.escaped
}

func (p *jsParser) expect(punct string, exprStart bool) {
	if !p.is(punct) {
		p.fail("Unexpected token")
	}
	p.advance(exprStart)
}

func (p *jsParser) node(typ string, start int) *jsNode {
	return &jsNode{Type: typ, start: start, end: p.lastEnd()}
}

// lastEnd is the end of the previous token; the parser tracks it by keeping
// the token before advancing.
func (p *jsParser) lastEnd() int { return p.prevEnd }

func (p *jsParser) advance(exprStart bool) {
	p.prevEnd = p.tok.end
	p.next(exprStart)
}

func (p *jsParser) parseExpression() *jsNode {
	start := p.tok.start
	expr := p.parseAssign()
	if !p.is(",") {
		return expr
	}
	for p.is(",") {
		p.advance(true)
		p.parseAssign()
	}
	return p.node("SequenceExpression", start)
}

var assignOps = map[string]bool{"=": true, "+=": true, "-=": true, "*=": true, "/=": true, "%=": true, "**=": true, "<<=": true, ">>=": true, ">>>=": true, "&=": true, "|=": true, "^=": true, "&&=": true, "||=": true, "??=": true}

func (p *jsParser) parseAssign() *jsNode {
	start := p.tok.start
	if p.tok.kind == tName && !p.tok.escaped {
		switch p.tok.value {
		case "yield":
			p.fail("Cannot use keyword 'yield' outside a function")
		case "async":
			if arrow := p.tryAsyncArrow(); arrow != nil {
				return arrow
			}
		}
		if !reservedWords[p.tok.value] || p.tok.value == "await" {
			if arrow := p.tryIdentArrow(); arrow != nil {
				return arrow
			}
		}
	}
	left := p.parseConditional()
	if p.tok.kind == tPunct && assignOps[p.tok.value] {
		op := p.tok.value
		if !assignable(left, op == "=") {
			p.fail("Assigning to rvalue")
		}
		p.advance(true)
		p.parseAssign()
		return p.node("AssignmentExpression", start)
	}
	if left.cover {
		p.fail("Shorthand property assignments are valid only in destructuring patterns")
	}
	return left
}

func assignable(n *jsNode, pattern bool) bool {
	switch n.Type {
	case "Identifier", "MemberExpression":
		return true
	case "ObjectExpression", "ArrayExpression":
		return pattern && !n.paren
	}
	return false
}

// tryIdentArrow parses `name => body` when the token after the name is `=>`.
func (p *jsParser) tryIdentArrow() *jsNode {
	save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
	start := p.tok.start
	p.advance(false)
	if p.is("=>") && !p.tok.nlBefore {
		if saveTok.value == "await" {
			p.fail("Cannot use 'await' as identifier inside an async function")
		}
		p.advance(true)
		p.parseArrowBody()
		return p.node("ArrowFunctionExpression", start)
	}
	p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
	return nil
}

func (p *jsParser) tryAsyncArrow() *jsNode {
	save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
	start := p.tok.start
	p.advance(false)
	if p.tok.nlBefore {
		p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
		return nil
	}
	if p.tok.kind == tName && !reservedWords[p.tok.value] {
		p.advance(false)
		if p.is("=>") && !p.tok.nlBefore {
			p.advance(true)
			p.parseArrowBody()
			return p.node("ArrowFunctionExpression", start)
		}
		p.fail("Unexpected token")
	}
	if p.is("(") {
		p.skipBalanced("(", ")")
		if p.is("=>") && !p.tok.nlBefore {
			p.advance(true)
			p.parseArrowBody()
			return p.node("ArrowFunctionExpression", start)
		}
	}
	p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
	return nil
}

func (p *jsParser) parseArrowBody() {
	if p.is("{") {
		p.skipBalanced("{", "}")
		return
	}
	p.parseAssign()
}

func (p *jsParser) parseConditional() *jsNode {
	start := p.tok.start
	test := p.parseBinary(0)
	if !p.is("?") {
		return test
	}
	if test.cover {
		p.fail("Shorthand property assignments are valid only in destructuring patterns")
	}
	p.advance(true)
	p.parseAssign()
	p.expect(":", true)
	p.parseAssign()
	return p.node("ConditionalExpression", start)
}

var binaryPrec = map[string]int{
	"??": 1, "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5,
	"==": 6, "!=": 6, "===": 6, "!==": 6,
	"<": 7, ">": 7, "<=": 7, ">=": 7, "instanceof": 7, "in": 7,
	"<<": 8, ">>": 8, ">>>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10, "**": 11,
}

func (p *jsParser) binaryOp() (string, int) {
	if p.tok.kind == tPunct {
		if prec, ok := binaryPrec[p.tok.value]; ok {
			return p.tok.value, prec
		}
	}
	if p.tok.kind == tName && !p.tok.escaped && (p.tok.value == "instanceof" || p.tok.value == "in") {
		return p.tok.value, 7
	}
	return "", -1
}

func (p *jsParser) parseBinary(minPrec int) *jsNode {
	start := p.tok.start
	var left *jsNode
	if p.tok.kind == tPrivate {
		p.advance(false)
		if !p.isName("in") {
			p.fail("Unexpected token")
		}
		p.fail("Private field must be declared in an enclosing class")
	}
	left = p.parseUnary()
	return p.parseBinaryRest(left, start, minPrec)
}

func (p *jsParser) parseBinaryRest(left *jsNode, start, minPrec int) *jsNode {
	for {
		op, prec := p.binaryOp()
		if prec < 0 || prec <= minPrec && !(op == "**" && prec == minPrec) {
			return left
		}
		if op == "**" && left.Type == "UnaryExpression" && !left.paren {
			p.fail("Unexpected token")
		}
		if left.cover {
			p.fail("Shorthand property assignments are valid only in destructuring patterns")
		}
		p.advance(true)
		rightStart := p.tok.start
		right := p.parseUnary()
		nextMin := prec
		if op == "**" {
			nextMin = prec - 1
		}
		right = p.parseBinaryRest(right, rightStart, nextMin)
		typ := "BinaryExpression"
		if op == "||" || op == "&&" || op == "??" {
			typ = "LogicalExpression"
			if (op == "??" && (isLogical(left, "||", "&&") || isLogical(right, "||", "&&"))) ||
				(op != "??" && (isLogical(left, "??") || isLogical(right, "??"))) {
				p.fail("Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses")
			}
		}
		left = &jsNode{Type: typ, Operator: op, start: start, end: p.lastEnd()}
	}
}

func isLogical(n *jsNode, ops ...string) bool {
	if n.Type != "LogicalExpression" || n.paren {
		return false
	}
	for _, op := range ops {
		if n.Operator == op {
			return true
		}
	}
	return false
}

func (p *jsParser) parseUnary() *jsNode {
	start := p.tok.start
	if p.tok.kind == tPunct {
		switch p.tok.value {
		case "+", "-", "!", "~":
			op := p.tok.value
			p.advance(true)
			arg := p.parseUnary()
			if arg.cover {
				p.fail("Shorthand property assignments are valid only in destructuring patterns")
			}
			n := p.node("UnaryExpression", start)
			n.Operator, n.Argument = op, arg
			return n
		case "++", "--":
			p.advance(true)
			arg := p.parseUnary()
			if !assignable(arg, false) {
				p.fail("Assigning to rvalue")
			}
			return p.node("UpdateExpression", start)
		}
	}
	if p.tok.kind == tName && !p.tok.escaped {
		switch p.tok.value {
		case "typeof", "void", "delete":
			op := p.tok.value
			p.advance(true)
			arg := p.parseUnary()
			if op == "delete" && arg.Type == "Identifier" && !arg.paren {
				p.fail("Deleting local variable in strict mode")
			}
			n := p.node("UnaryExpression", start)
			n.Operator, n.Argument = op, arg
			return n
		case "await":
			p.advance(true)
			p.parseUnary()
			return p.node("AwaitExpression", start)
		}
	}
	expr := p.parseSubscripts(p.parseAtom(), start, false)
	if (p.is("++") || p.is("--")) && !p.tok.nlBefore {
		if !assignable(expr, false) {
			p.fail("Assigning to rvalue")
		}
		p.advance(false)
		return p.node("UpdateExpression", start)
	}
	return expr
}

func (p *jsParser) parseSubscripts(base *jsNode, start int, noCalls bool) *jsNode {
	chain := false
	for {
		switch {
		case p.is("."):
			p.advance(false)
			if p.tok.kind != tName && p.tok.kind != tPrivate {
				p.fail("Unexpected token")
			}
			if p.tok.kind == tPrivate {
				p.fail("Private field must be declared in an enclosing class")
			}
			p.advance(false)
			base = p.node("MemberExpression", start)
		case p.is("?."):
			if noCalls {
				p.fail("Optional chaining cannot appear in the callee of new expressions")
			}
			chain = true
			p.advance(false)
			switch {
			case p.is("("):
				p.parseArguments()
				base = p.node("CallExpression", start)
			case p.is("["):
				p.advance(true)
				p.parseExpression()
				p.expect("]", false)
				base = p.node("MemberExpression", start)
			case p.tok.kind == tName:
				p.advance(false)
				base = p.node("MemberExpression", start)
			default:
				p.fail("Unexpected token")
			}
		case p.is("["):
			p.advance(true)
			p.parseExpression()
			p.expect("]", false)
			base = p.node("MemberExpression", start)
		case p.is("(") && !noCalls:
			p.parseArguments()
			base = p.node("CallExpression", start)
		case p.is("`"):
			if chain {
				p.fail("Optional chaining cannot appear in the tag of tagged template expressions")
			}
			p.parseTemplate(true)
			base = p.node("TaggedTemplateExpression", start)
		default:
			if chain {
				return &jsNode{Type: "ChainExpression", start: start, end: base.end}
			}
			return base
		}
	}
}

func (p *jsParser) parseArguments() {
	p.advance(true)
	for !p.is(")") {
		if p.is("...") {
			p.advance(true)
		}
		p.parseAssign()
		if !p.is(")") {
			p.expect(",", true)
		}
	}
	p.advance(false)
}

func (p *jsParser) parseAtom() *jsNode {
	start := p.tok.start
	switch p.tok.kind {
	case tNum:
		n := &jsNode{Type: "Literal", Value: p.tok.num, Bigint: p.tok.bigint, start: start, end: p.tok.end}
		p.advance(false)
		return n
	case tString:
		n := &jsNode{Type: "Literal", Value: p.tok.str, start: start, end: p.tok.end}
		p.advance(false)
		return n
	case tRegex:
		n := &jsNode{Type: "Literal", Regex: true, start: start, end: p.tok.end}
		p.advance(false)
		return n
	case tName:
		return p.parseNameAtom()
	case tPunct:
		switch p.tok.value {
		case "(":
			return p.parseParen()
		case "[":
			return p.parseArray()
		case "{":
			return p.parseObject()
		case "`":
			p.parseTemplate(false)
			return p.lastTemplate
		case "<":
			p.parseJSX(start)
			p.prevEnd = p.pos
			p.next(false)
			return p.node("JSXElement", start)
		}
	}
	p.fail("Unexpected token")
	return nil
}

func (p *jsParser) parseNameAtom() *jsNode {
	start := p.tok.start
	name := p.tok.value
	if p.tok.escaped && reservedWords[name] {
		p.fail("Escape sequence in keyword " + name)
	}
	switch name {
	case "this":
		p.advance(false)
		return p.node("ThisExpression", start)
	case "null":
		p.advance(false)
		n := p.node("Literal", start)
		n.Value = nil
		return n
	case "true", "false":
		p.advance(false)
		n := p.node("Literal", start)
		n.Value = name == "true"
		return n
	case "function":
		p.parseFunctionRest()
		return p.node("FunctionExpression", start)
	case "async":
		save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
		p.advance(false)
		if p.isName("function") && !p.tok.nlBefore {
			p.parseFunctionRest()
			return p.node("FunctionExpression", start)
		}
		p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
	case "class":
		p.parseClassRest()
		return p.node("ClassExpression", start)
	case "new":
		p.advance(true)
		if p.is(".") {
			p.fail("'new.target' can only be used in functions and class static block")
		}
		calleeStart := p.tok.start
		p.parseSubscripts(p.parseAtom(), calleeStart, true)
		if p.is("(") {
			p.parseArguments()
		}
		return p.node("NewExpression", start)
	case "import":
		p.advance(false)
		if p.is(".") {
			p.advance(false)
			if !p.isName("meta") {
				p.fail("The only valid meta property for import is 'import.meta'")
			}
			p.advance(false)
			return p.node("MetaProperty", start)
		}
		if p.is("(") {
			p.advance(true)
			p.parseAssign()
			if p.is(",") {
				p.advance(true)
				if !p.is(")") {
					p.parseAssign()
					if p.is(",") {
						p.advance(true)
					}
				}
			}
			p.expect(")", false)
			return p.node("ImportExpression", start)
		}
		p.fail("Unexpected token")
	case "super":
		p.fail("'super' keyword outside a method")
	}
	if reservedWords[name] && name != "await" {
		p.fail("Unexpected keyword '" + name + "'")
	}
	if name == "await" {
		p.fail("Cannot use keyword 'await' outside an async function")
	}
	p.advance(false)
	n := p.node("Identifier", start)
	n.Name = name
	return n
}

func (p *jsParser) parseParen() *jsNode {
	start := p.tok.start
	p.advance(true)
	if p.is(")") {
		p.advance(false)
		if !p.is("=>") || p.tok.nlBefore {
			p.fail("Unexpected token")
		}
		p.advance(true)
		p.parseArrowBody()
		return p.node("ArrowFunctionExpression", start)
	}
	var inner *jsNode
	rest := false
	exprStart := p.tok.start
	count := 0
	for {
		if p.is("...") {
			rest = true
			p.advance(true)
			p.parseAssignTarget()
		} else {
			inner = p.parseAssignAllowCover()
		}
		count++
		if !p.is(",") {
			break
		}
		p.advance(true)
		if p.is(")") {
			rest = true // trailing comma is only valid in arrow parameters
			break
		}
	}
	p.expect(")", false)
	if p.is("=>") && !p.tok.nlBefore {
		p.advance(true)
		p.parseArrowBody()
		return p.node("ArrowFunctionExpression", start)
	}
	if rest {
		p.fail("Unexpected token")
	}
	if count > 1 {
		inner = &jsNode{Type: "SequenceExpression", start: exprStart}
	}
	if inner.cover {
		p.fail("Shorthand property assignments are valid only in destructuring patterns")
	}
	inner.paren = true
	inner.parens++
	inner.start, inner.end = start, p.lastEnd()
	return inner
}

// parseAssignAllowCover parses an assignment expression inside parentheses,
// where `{a = 1}` may still turn out to be an arrow parameter pattern.
func (p *jsParser) parseAssignAllowCover() *jsNode {
	start := p.tok.start
	left := p.parseConditional()
	if p.tok.kind == tPunct && assignOps[p.tok.value] {
		if !assignable(left, p.tok.value == "=") {
			p.fail("Assigning to rvalue")
		}
		p.advance(true)
		p.parseAssign()
		return p.node("AssignmentExpression", start)
	}
	return left
}

func (p *jsParser) parseAssignTarget() {
	switch {
	case p.is("["):
		p.skipBalanced("[", "]")
	case p.is("{"):
		p.skipBalanced("{", "}")
	case p.tok.kind == tName && !reservedWords[p.tok.value]:
		p.advance(false)
	default:
		p.fail("Unexpected token")
	}
}

func (p *jsParser) parseArray() *jsNode {
	start := p.tok.start
	p.advance(true)
	var elements []*jsNode
	for !p.is("]") {
		if p.is(",") {
			elements = append(elements, nil)
			p.advance(true)
			continue
		}
		var el *jsNode
		if p.is("...") {
			spreadStart := p.tok.start
			p.advance(true)
			p.parseAssign()
			el = p.node("SpreadElement", spreadStart)
		} else {
			el = p.parseAssignAllowCover()
		}
		elements = append(elements, el)
		if !p.is("]") {
			p.expect(",", true)
		}
	}
	p.advance(false)
	n := p.node("ArrayExpression", start)
	n.Elements = elements
	return n
}

func (p *jsParser) propertyKeyStart() bool {
	return p.tok.kind == tName || p.tok.kind == tString || p.tok.kind == tNum || p.is("[") || p.tok.kind == tPrivate
}

func (p *jsParser) parseObject() *jsNode {
	start := p.tok.start
	p.advance(false)
	n := &jsNode{Type: "ObjectExpression", start: start}
	for !p.is("}") {
		propStart := p.tok.start
		if p.is("...") {
			p.advance(true)
			arg := p.parseAssign()
			n.Props = append(n.Props, &jsProp{Type: "SpreadElement", Value: arg, start: propStart})
		} else {
			prop := &jsProp{Type: "Property", Kind: "init", start: propStart}
			isAsync, isGenerator := false, false
			if p.isName("async") || p.isName("get") || p.isName("set") {
				word := p.tok.value
				save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
				p.advance(false)
				if (p.propertyKeyStart() || (word == "async" && p.is("*"))) && !(word == "async" && p.tok.nlBefore) {
					if word == "async" {
						isAsync = true
					} else {
						prop.Kind = word
					}
				} else {
					p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
				}
			}
			if p.is("*") {
				isGenerator = true
				p.advance(false)
			}
			key := p.parsePropertyKey(prop)
			switch {
			case p.is("("):
				prop.Method = prop.Kind == "init"
				p.skipBalanced("(", ")")
				if !p.is("{") {
					p.fail("Unexpected token")
				}
				p.skipBalanced("{", "}")
				prop.Value = &jsNode{Type: "FunctionExpression"}
			case isAsync || isGenerator || prop.Kind != "init":
				p.fail("Unexpected token")
			case p.is(":"):
				p.advance(true)
				prop.Value = p.parseAssignAllowCover()
			default:
				if prop.Computed || key.Type != "Identifier" {
					p.fail("Unexpected token")
				}
				if reservedWords[key.Name] {
					p.fail("Unexpected keyword '" + key.Name + "'")
				}
				prop.Value = &jsNode{Type: "Identifier", Name: key.Name}
				if p.is("=") {
					p.advance(true)
					p.parseAssign()
					n.cover = true
				}
			}
			n.Props = append(n.Props, prop)
		}
		if !p.is("}") {
			p.expect(",", false)
		}
	}
	p.advance(false)
	n.end = p.lastEnd()
	return n
}

func (p *jsParser) parsePropertyKey(prop *jsProp) *jsNode {
	start := p.tok.start
	switch p.tok.kind {
	case tName:
		k := &jsNode{Type: "Identifier", Name: p.tok.value, start: start, end: p.tok.end}
		p.advance(false)
		prop.Key = k
	case tString:
		prop.Key = &jsNode{Type: "Literal", Value: p.tok.str, start: start, end: p.tok.end}
		p.advance(false)
	case tNum:
		prop.Key = &jsNode{Type: "Literal", Value: p.tok.num, Bigint: p.tok.bigint, start: start, end: p.tok.end}
		p.advance(false)
	case tPunct:
		if !p.is("[") {
			p.fail("Unexpected token")
		}
		p.advance(true)
		prop.Key = p.parseAssign()
		prop.Computed = true
		p.expect("]", false)
	default:
		p.fail("Unexpected token")
	}
	return prop.Key
}

// parseFunctionRest parses a function expression from `function`.
func (p *jsParser) parseFunctionRest() {
	p.advance(false) // function
	if p.is("*") {
		p.advance(false)
	}
	if p.tok.kind == tName {
		if reservedWords[p.tok.value] {
			p.fail("Unexpected keyword '" + p.tok.value + "'")
		}
		p.advance(false)
	}
	p.functionRest()
}

// functionRest parses parameters and body.
func (p *jsParser) functionRest() {
	if !p.is("(") {
		p.fail("Unexpected token")
	}
	p.skipBalanced("(", ")")
	if !p.is("{") {
		p.fail("Unexpected token")
	}
	p.skipBalanced("{", "}")
}

// parseClassRest parses a class expression from `class`.
func (p *jsParser) parseClassRest() {
	p.advance(false) // class
	if p.tok.kind == tName && !p.isName("extends") {
		if reservedWords[p.tok.value] {
			p.fail("Unexpected keyword '" + p.tok.value + "'")
		}
		p.advance(false)
	}
	p.classRest()
}

// classRest parses an optional heritage and the body.
func (p *jsParser) classRest() {
	if p.isName("extends") {
		p.advance(true)
		start := p.tok.start
		p.parseSubscripts(p.parseAtom(), start, false)
	}
	if !p.is("{") {
		p.fail("Unexpected token")
	}
	p.skipBalanced("{", "}")
}

// skipBalanced skips from an opening bracket (the current token) through its
// matching close, leaving the token after it current.
func (p *jsParser) skipBalanced(open, close string) {
	depth := 0
	exprStart := true
	for {
		switch {
		case p.tok.kind == tEOF:
			p.fail("Unexpected token")
		case p.is("`"):
			p.parseTemplate(true)
			exprStart = false
			continue
		case p.is("{") || p.is("(") || p.is("["):
			depth++
		case p.is("}") || p.is(")") || p.is("]"):
			depth--
			if depth == 0 {
				if p.tok.value != close {
					p.fail("Unexpected token")
				}
				p.advance(false)
				return
			}
		}
		switch p.tok.kind {
		case tPunct:
			exprStart = !(p.is(")") || p.is("]") || p.is("}"))
		case tName:
			exprStart = map[string]bool{"return": true, "typeof": true, "case": true, "do": true, "else": true, "in": true, "instanceof": true, "new": true, "void": true, "delete": true, "throw": true, "yield": true, "await": true, "of": true}[p.tok.value]
		default:
			exprStart = false
		}
		p.advance(exprStart)
	}
}

// parseTemplate parses a template literal whose opening backtick is the
// current token, leaving the token after it current.
func (p *jsParser) parseTemplate(tagged bool) {
	start := p.tok.start
	p.pos = p.tok.end
	n := &jsNode{Type: "TemplateLiteral", start: start}
	var units []uint16
	valid := true
	for {
		if p.pos >= len(p.src) {
			p.fail("Unterminated template")
		}
		r, size := p.peekRune(p.pos)
		switch {
		case r == '`':
			p.pos++
			n.Quasis = append(n.Quasis, decodeUnits(units))
			n.end = p.pos
			p.lastTemplate = n
			p.prevEnd = p.pos
			p.next(false)
			return
		case r == '$' && strings.HasPrefix(p.src[p.pos:], "${"):
			n.Quasis = append(n.Quasis, decodeUnits(units))
			units = nil
			p.pos += 2
			p.next(true)
			n.Exprs = append(n.Exprs, p.parseExpression())
			if !p.is("}") {
				p.fail("Unexpected token")
			}
			p.pos = p.tok.end
		case r == '\\':
			p.pos++
			if !p.readEscape(&units) {
				valid = false
			}
		case r == '\r':
			p.pos++
			if p.pos < len(p.src) && p.src[p.pos] == '\n' {
				p.pos++
			}
			units = append(units, '\n')
		default:
			units = append(units, utf16.Encode([]rune{r})...)
			p.pos += size
		}
		if !valid && !tagged {
			p.fail("Bad escape sequence in untagged template literal")
		}
	}
}

// ---------- JSX ----------

func (p *jsParser) rawSpace() {
	p.skipSpace()
}

func (p *jsParser) jsxName() string {
	start := p.pos
	r, _ := p.peekRune(p.pos)
	if !isIDStart(r) {
		p.fail("Unexpected token")
	}
	for p.pos < len(p.src) {
		r, size := p.peekRune(p.pos)
		if !isIDCont(r) && r != '-' {
			break
		}
		p.pos += size
	}
	return p.src[start:p.pos]
}

func (p *jsParser) jsxElementName() string {
	p.rawSpace()
	if p.pos < len(p.src) && p.src[p.pos] == '>' {
		return ""
	}
	name := p.jsxName()
	p.rawSpace()
	if p.pos < len(p.src) && p.src[p.pos] == ':' {
		p.pos++
		p.rawSpace()
		return name + ":" + p.jsxName()
	}
	for p.pos < len(p.src) && p.src[p.pos] == '.' {
		p.pos++
		p.rawSpace()
		name += "." + p.jsxName()
		p.rawSpace()
	}
	return name
}

// jsxExpression parses `{...}` starting at p.pos (just after the brace) and
// leaves p.pos after the closing brace.
func (p *jsParser) jsxExpression(allowEmpty bool) {
	p.next(true)
	if p.is("}") {
		if !allowEmpty {
			p.fail("JSX attributes must only be assigned a non-empty expression")
		}
	} else {
		if p.is("...") {
			p.next(true)
		}
		p.parseExpression()
		if !p.is("}") {
			p.fail("Unexpected token")
		}
	}
	p.pos = p.tok.end
}

// parseJSX parses an element whose `<` is the current token; on return p.pos
// is just after the element.
func (p *jsParser) parseJSX(start int) {
	p.pos = start + 1
	name := p.jsxElementName()
	for {
		p.rawSpace()
		if p.pos >= len(p.src) {
			p.fail("Unexpected token")
		}
		c := p.src[p.pos]
		switch {
		case c == '/':
			p.pos++
			p.rawSpace()
			if p.pos >= len(p.src) || p.src[p.pos] != '>' {
				p.fail("Unexpected token")
			}
			p.pos++
			return
		case c == '>':
			p.pos++
			p.jsxChildren(name)
			return
		case c == '{':
			p.pos++
			p.jsxExpression(false)
		default:
			p.jsxName()
			p.rawSpace()
			if p.pos < len(p.src) && p.src[p.pos] == ':' {
				p.pos++
				p.jsxName()
				p.rawSpace()
			}
			if p.pos < len(p.src) && p.src[p.pos] == '=' {
				p.pos++
				p.rawSpace()
				if p.pos >= len(p.src) {
					p.fail("Unexpected token")
				}
				switch q := p.src[p.pos]; q {
				case '"', '\'':
					end := strings.IndexByte(p.src[p.pos+1:], q)
					if end < 0 {
						p.pos = len(p.src)
						p.fail("Unterminated string constant")
					}
					p.pos += end + 2
				case '{':
					p.pos++
					p.jsxExpression(false)
				case '<':
					p.parseJSX(p.pos)
				default:
					p.fail("JSX value should be either an expression or a quoted JSX text")
				}
			}
		}
	}
}

func (p *jsParser) jsxChildren(name string) {
	for {
		if p.pos >= len(p.src) {
			p.fail("Unterminated JSX contents")
		}
		switch p.src[p.pos] {
		case '{':
			p.pos++
			p.jsxExpression(true)
		case '<':
			p.pos++
			p.rawSpace()
			if p.pos < len(p.src) && p.src[p.pos] == '/' {
				p.pos++
				closing := p.jsxElementName()
				p.rawSpace()
				if p.pos >= len(p.src) || p.src[p.pos] != '>' {
					p.fail("Unexpected token")
				}
				p.pos++
				if closing != name {
					p.fail("Expected corresponding JSX closing tag for <" + name + ">")
				}
				return
			}
			p.parseJSX(p.pos - 1)
		case '>', '}':
			p.fail("Unexpected token")
		default:
			_, size := p.peekRune(p.pos)
			p.pos += size
		}
	}
}

// ---------- modules (import/export blocks) ----------

// moduleScope tracks top-level bindings so redeclarations and exports of
// undeclared names fail the way acorn does.
type moduleScope struct {
	kinds   map[string]string // var or lexical
	exports []string
	imports []string
}

func (p *jsParser) declare(name string, lexical bool) {
	kind := "var"
	if lexical {
		kind = "lexical"
	}
	if prev, ok := p.scope.kinds[name]; ok && (prev == "lexical" || lexical) {
		p.fail("Identifier '" + name + "' has already been declared")
	}
	p.scope.kinds[name] = kind
}

func (p *jsParser) semicolon() {
	if p.is(";") {
		p.advance(true)
		return
	}
	if p.tok.kind == tEOF || p.is("}") || p.tok.nlBefore {
		return
	}
	p.fail("Unexpected token")
}

func (p *jsParser) moduleString() {
	if p.tok.kind != tString {
		p.fail("Unexpected token")
	}
	p.advance(false)
	if p.isName("with") && !p.tok.nlBefore {
		p.advance(false)
		if !p.is("{") {
			p.fail("Unexpected token")
		}
		p.skipBalanced("{", "}")
	}
}

func (p *jsParser) bindingIdentifier(lexical bool) string {
	if p.tok.kind != tName || reservedWords[p.tok.value] {
		p.fail("Unexpected token")
	}
	name := p.tok.value
	p.advance(false)
	if p.scope != nil {
		p.declare(name, lexical)
	}
	return name
}

func (p *jsParser) importBinding() {
	name := p.bindingIdentifier(true)
	p.scope.imports = append(p.scope.imports, name)
}

func (p *jsParser) importSpecifiers() {
	p.advance(false) // {
	for !p.is("}") {
		if p.tok.kind != tName && p.tok.kind != tString {
			p.fail("Unexpected token")
		}
		imported := p.tok
		save, savePrev := p.pos, p.prevEnd
		p.advance(false)
		if p.isName("as") {
			p.advance(false)
			p.importBinding()
		} else {
			if imported.kind == tString {
				p.fail("Unexpected token")
			}
			p.pos, p.tok, p.prevEnd = save, imported, savePrev
			p.importBinding()
		}
		if !p.is("}") {
			p.expect(",", false)
		}
	}
	p.advance(false)
}

// exportSpecifiers parses `{ a, b as c }` and returns the local names.
func (p *jsParser) exportSpecifiers() (locals []token) {
	p.advance(false) // {
	for !p.is("}") {
		if p.tok.kind != tName && p.tok.kind != tString {
			p.fail("Unexpected token")
		}
		locals = append(locals, p.tok)
		p.advance(false)
		if p.isName("as") {
			p.advance(false)
			if p.tok.kind != tName && p.tok.kind != tString {
				p.fail("Unexpected token")
			}
			p.advance(false)
		}
		if !p.is("}") {
			p.expect(",", false)
		}
	}
	p.advance(false)
	return locals
}

// parseModule parses an import/export block, with names imported by earlier
// blocks predeclared as variables. It returns each top-level statement type
// and the names this block imports.
func parseModule(src string, predeclared []string) (types, imports []string, err *jsError) {
	err = parseJS(src, func(p *jsParser) {
		p.scope = &moduleScope{kinds: map[string]string{}}
		for _, name := range predeclared {
			p.scope.kinds[name] = "var"
		}
		p.next(true)
		for p.tok.kind != tEOF {
			types = append(types, p.parseStatement())
		}
		for _, name := range p.scope.exports {
			if _, ok := p.scope.kinds[name]; !ok {
				p.fail("Export '" + name + "' is not defined")
			}
		}
		imports = p.scope.imports
	})
	return types, imports, err
}

func (p *jsParser) parseStatement() string {
	if p.is(";") {
		p.advance(true)
		return "EmptyStatement"
	}
	if p.isName("import") {
		save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
		p.advance(false)
		if !p.is("(") && !p.is(".") {
			p.parseImportRest()
			return "ImportDeclaration"
		}
		p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
	}
	if p.isName("export") {
		return p.parseExportRest()
	}
	switch {
	case p.isName("var") || p.isName("const"):
		p.parseVarDeclaration()
		return "VariableDeclaration"
	case p.isName("let"):
		save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
		p.advance(false)
		if p.tok.kind == tName || p.is("[") || p.is("{") {
			p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
			p.parseVarDeclaration()
			return "VariableDeclaration"
		}
		p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
	case p.isName("function"):
		p.parseFunctionDeclaration()
		return "FunctionDeclaration"
	case p.isName("class"):
		p.parseClassDeclaration()
		return "ClassDeclaration"
	case p.isName("return"):
		p.fail("'return' outside of function")
	case p.is("{"):
		p.skipBalanced("{", "}")
		return "BlockStatement"
	}
	if p.tok.kind == tName {
		if typ, ok := map[string]string{
			"if": "IfStatement", "for": "ForStatement", "while": "WhileStatement", "do": "DoWhileStatement",
			"switch": "SwitchStatement", "try": "TryStatement", "throw": "ThrowStatement", "debugger": "DebuggerStatement",
		}[p.tok.value]; ok {
			// Compound statements are never valid in a plan; report the type
			// without validating the rest of the block.
			p.pos = len(p.src)
			p.next(false)
			return typ
		}
		if p.tok.value == "async" {
			save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
			p.advance(false)
			if p.isName("function") && !p.tok.nlBefore {
				p.parseFunctionDeclaration()
				return "FunctionDeclaration"
			}
			p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
		}
	}
	p.parseExpression()
	p.semicolon()
	return "ExpressionStatement"
}

// parseFunctionDeclaration parses `function name(...) {...}` with the
// current token on `function`.
func (p *jsParser) parseFunctionDeclaration() {
	p.advance(false) // function
	if p.is("*") {
		p.advance(false)
	}
	p.bindingIdentifier(true)
	p.functionRest()
}

func (p *jsParser) parseClassDeclaration() {
	p.advance(false) // class
	if p.isName("extends") {
		p.fail("Unexpected token")
	}
	p.bindingIdentifier(true)
	p.classRest()
}

func (p *jsParser) parseVarDeclaration() {
	kind := p.tok.value
	p.advance(false)
	for {
		pattern := false
		switch {
		case p.is("["):
			p.skipBalanced("[", "]")
			pattern = true
		case p.is("{"):
			p.skipBalanced("{", "}")
			pattern = true
		default:
			p.bindingIdentifier(kind != "var")
		}
		if p.is("=") {
			p.advance(true)
			p.parseAssign()
		} else if kind == "const" || pattern {
			p.fail("Missing initializer in const declaration")
		}
		if !p.is(",") {
			break
		}
		p.advance(false)
	}
	p.semicolon()
}

func (p *jsParser) parseImportRest() {
	switch {
	case p.tok.kind == tString:
		p.moduleString()
		p.semicolon()
		return
	case p.is("*"):
		p.advance(false)
		if !p.isName("as") {
			p.fail("Unexpected token")
		}
		p.advance(false)
		p.importBinding()
	case p.is("{"):
		p.importSpecifiers()
	default:
		p.importBinding()
		if p.is(",") {
			p.advance(false)
			switch {
			case p.is("*"):
				p.advance(false)
				if !p.isName("as") {
					p.fail("Unexpected token")
				}
				p.advance(false)
				p.importBinding()
			case p.is("{"):
				p.importSpecifiers()
			default:
				p.fail("Unexpected token")
			}
		}
	}
	if !p.isName("from") {
		p.fail("Unexpected token")
	}
	p.advance(false)
	p.moduleString()
	p.semicolon()
}

func (p *jsParser) parseExportRest() string {
	p.advance(true) // export
	switch {
	case p.is("*"):
		p.advance(false)
		if p.isName("as") {
			p.advance(false)
			if p.tok.kind != tName && p.tok.kind != tString {
				p.fail("Unexpected token")
			}
			p.advance(false)
		}
		if !p.isName("from") {
			p.fail("Unexpected token")
		}
		p.advance(false)
		p.moduleString()
		p.semicolon()
		return "ExportAllDeclaration"
	case p.isName("default"):
		p.advance(true)
		switch {
		case p.isName("function"):
			p.advance(false)
			if p.is("*") {
				p.advance(false)
			}
			if p.tok.kind == tName {
				p.bindingIdentifier(true)
			}
			p.functionRest()
		case p.isName("class"):
			p.advance(false)
			if p.tok.kind == tName && !p.isName("extends") {
				p.bindingIdentifier(true)
			}
			p.classRest()
		case p.isName("async"):
			save, saveTok, savePrev := p.pos, p.tok, p.prevEnd
			p.advance(false)
			if p.isName("function") && !p.tok.nlBefore {
				p.advance(false)
				if p.is("*") {
					p.advance(false)
				}
				if p.tok.kind == tName {
					p.bindingIdentifier(true)
				}
				p.functionRest()
				return "ExportDefaultDeclaration"
			}
			p.pos, p.tok, p.prevEnd = save, saveTok, savePrev
			p.parseAssign()
			p.semicolon()
		default:
			p.parseAssign()
			p.semicolon()
		}
		return "ExportDefaultDeclaration"
	case p.is("{"):
		locals := p.exportSpecifiers()
		if p.isName("from") {
			p.advance(false)
			p.moduleString()
		} else {
			// Without `from`, local names must be declared identifiers.
			for _, local := range locals {
				if local.kind == tString || reservedWords[local.value] {
					p.fail("Unexpected keyword '" + local.value + "'")
				}
				p.scope.exports = append(p.scope.exports, local.value)
			}
		}
		p.semicolon()
		return "ExportNamedDeclaration"
	case p.isName("var") || p.isName("let") || p.isName("const"):
		p.parseVarDeclaration()
	case p.isName("function"):
		p.parseFunctionDeclaration()
	case p.isName("class"):
		p.parseClassDeclaration()
	case p.isName("async"):
		p.advance(false)
		if !p.isName("function") || p.tok.nlBefore {
			p.fail("Unexpected token")
		}
		p.parseFunctionDeclaration()
	default:
		p.fail("Unexpected token")
	}
	return "ExportNamedDeclaration"
}
