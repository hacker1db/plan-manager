package mdxrender

import (
	"bytes"
	"html"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	gast "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	gtext "github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Parsing happens in two steps that mirror remark-mdx. goldmark tokenizes the
// Markdown with HTML, autolinks, and indented code disabled, as mdx-md does,
// and with MDX constructs added as custom block and inline nodes. Tags are
// tokens, not containers: a builder then replays the goldmark tree in
// document order and pairs opening and closing tags the way
// mdast-util-mdx-jsx does, raising its errors when they do not nest.

// ---------- custom goldmark nodes ----------

var (
	kindFlow     = gast.NewNodeKind("MdxFlow")
	kindEsm      = gast.NewNodeKind("MdxjsEsm")
	kindTextTag  = gast.NewNodeKind("MdxJsxTextTag")
	kindTextExpr = gast.NewNodeKind("MdxTextExpression")
)

type flowNode struct {
	gast.BaseBlock
	items []flowItem
}

func (n *flowNode) Kind() gast.NodeKind           { return kindFlow }
func (n *flowNode) Dump(source []byte, level int) { gast.DumpHelper(n, source, level, nil, nil) }
func (n *flowNode) IsRaw() bool                   { return true }

type esmNode struct {
	gast.BaseBlock
	start, end int
}

func (n *esmNode) Kind() gast.NodeKind           { return kindEsm }
func (n *esmNode) Dump(source []byte, level int) { gast.DumpHelper(n, source, level, nil, nil) }
func (n *esmNode) IsRaw() bool                   { return true }

type textTagNode struct {
	gast.BaseInline
	tag *jsxTag
}

func (n *textTagNode) Kind() gast.NodeKind           { return kindTextTag }
func (n *textTagNode) Dump(source []byte, level int) { gast.DumpHelper(n, source, level, nil, nil) }

type textExprNode struct {
	gast.BaseInline
	start, end int
}

func (n *textExprNode) Kind() gast.NodeKind           { return kindTextExpr }
func (n *textExprNode) Dump(source []byte, level int) { gast.DumpHelper(n, source, level, nil, nil) }

// ---------- syntax errors ----------

var stateKey = parser.NewContextKey()

type parseState struct {
	source  []byte
	errs    []rankedError
	imports []string // names imported by earlier ESM blocks
}

// Micromark tokenizes all flow (block) constructs before any text (inline)
// constructs, and throws at the first crash, so errors rank by phase, then
// by position.
type rankedError struct {
	phase  int
	offset int
	msg    string
}

func record(pc parser.Context, phase, offset int, err error) {
	st := pc.Get(stateKey).(*parseState)
	st.errs = append(st.errs, rankedError{phase: phase, offset: offset, msg: err.Error()})
}

// ---------- block parsers ----------

type flowParser struct{}

func (flowParser) Trigger() []byte { return []byte{'<', '{'} }

func (flowParser) Open(parent gast.Node, reader gtext.Reader, pc parser.Context) (gast.Node, parser.State) {
	line, seg := reader.PeekLine()
	pos := pc.BlockOffset()
	if pos < 0 || pos >= len(line) || (line[pos] != '<' && line[pos] != '{') || seg.Padding != 0 {
		return nil, parser.NoChildren
	}
	source := reader.Source()
	start := seg.Start + pos
	sc := &scanner{s: string(source), i: start}
	items, ok, err := sc.scanFlow()
	if err != nil {
		record(pc, 1, start, err)
		return nil, parser.NoChildren
	}
	if !ok {
		return nil, parser.NoChildren
	}
	end := items[len(items)-1].end
	node := &flowNode{items: items}
	node.Lines().Append(gtext.NewSegment(start, end))
	reader.Advance(end - seg.Start)
	return node, parser.NoChildren
}

func (flowParser) Continue(gast.Node, gtext.Reader, parser.Context) parser.State { return parser.Close }
func (flowParser) Close(gast.Node, gtext.Reader, parser.Context)                 {}
func (flowParser) CanInterruptParagraph() bool                                   { return true }
func (flowParser) CanAcceptIndentedLine() bool                                   { return true }

type esmParser struct{}

func (esmParser) Trigger() []byte { return []byte{'i', 'e'} }

func isBlankLine(line []byte) bool {
	return len(bytes.Trim(line, " \t\r\n")) == 0
}

func (esmParser) Open(parent gast.Node, reader gtext.Reader, pc parser.Context) (gast.Node, parser.State) {
	line, seg := reader.PeekLine()
	if pc.BlockOffset() != 0 || reader.LineOffset() != 0 || seg.Padding != 0 {
		return nil, parser.NoChildren
	}
	if !bytes.HasPrefix(line, []byte("import ")) && !bytes.HasPrefix(line, []byte("export ")) {
		return nil, parser.NoChildren
	}
	source := reader.Source()
	start := seg.Start
	lineEnd := func(at int) int {
		if i := bytes.IndexByte(source[at:], '\n'); i >= 0 {
			if i > 0 && source[at+i-1] == '\r' {
				return at + i - 1
			}
			return at + i
		}
		return len(source)
	}
	nextLine := func(end int) int {
		if end < len(source) && source[end] == '\r' {
			end++
		}
		return end + 1
	}
	end := lineEnd(start)
	for {
		// Content runs until a blank line or the end of the document.
		for end < len(source) {
			next := nextLine(end)
			if next >= len(source) || isBlankLine(source[next:lineEnd(next)]) {
				break
			}
			end = lineEnd(next)
		}
		st := pc.Get(stateKey).(*parseState)
		types, imports, jsErr := parseModule(string(source[start:end]), st.imports)
		if jsErr != nil {
			if end < len(source) && (jsErr.atEnd || jsErr.msg == "Unterminated comment") {
				end = lineEnd(nextLine(end))
				continue
			}
			record(pc, 1, start, &syntaxError{msg: "Could not parse import/exports with acorn"})
			return nil, parser.NoChildren
		}
		for _, typ := range types {
			switch typ {
			case "ExportAllDeclaration", "ExportDefaultDeclaration", "ExportNamedDeclaration", "ImportDeclaration":
			default:
				record(pc, 1, start, &syntaxError{msg: "Unexpected `" + typ + "` in code: only import/exports are supported"})
				return nil, parser.NoChildren
			}
		}
		st.imports = append(st.imports, imports...)
		break
	}
	node := &esmNode{start: start, end: end}
	node.Lines().Append(gtext.NewSegment(start, end))
	reader.Advance(end - seg.Start)
	return node, parser.NoChildren
}

func (esmParser) Continue(gast.Node, gtext.Reader, parser.Context) parser.State { return parser.Close }
func (esmParser) Close(gast.Node, gtext.Reader, parser.Context)                 {}
func (esmParser) CanInterruptParagraph() bool                                   { return false }
func (esmParser) CanAcceptIndentedLine() bool                                   { return false }

// indentTolerant lifts the four-space indent limit of CommonMark block
// starts: with indented code disabled, micromark accepts any indentation.
type indentTolerant struct{ parser.BlockParser }

func (b indentTolerant) CanAcceptIndentedLine() bool { return true }

func (b indentTolerant) Open(parent gast.Node, reader gtext.Reader, pc parser.Context) (gast.Node, parser.State) {
	if pc.BlockIndent() <= 3 {
		return b.BlockParser.Open(parent, reader, pc)
	}
	line, seg := reader.PeekLine()
	w, pos := util.IndentWidth(line, reader.LineOffset())
	if w <= 3 || pos >= len(line) || seg.Padding != 0 {
		return b.BlockParser.Open(parent, reader, pc)
	}
	savedLine, savedSeg := reader.Position()
	offset, indent := pc.BlockOffset(), pc.BlockIndent()
	reader.Advance(pos)
	pc.SetBlockOffset(0)
	pc.SetBlockIndent(0)
	node, state := b.BlockParser.Open(parent, reader, pc)
	if node == nil {
		reader.SetPosition(savedLine, savedSeg)
		reader.Advance(0) // SetPosition keeps the peeked line; drop it
		pc.SetBlockOffset(offset)
		pc.SetBlockIndent(indent)
	}
	return node, state
}

// ---------- inline parsers ----------

// rest collects the remainder of an inline block from the reader position,
// with each byte's absolute source offset.
func rest(block gtext.Reader) (string, []int) {
	line, seg := block.Position()
	defer block.SetPosition(line, seg)
	var b strings.Builder
	var offsets []int
	for {
		l, s := block.PeekLine()
		if l == nil {
			break
		}
		for i := range l {
			offsets = append(offsets, s.Start+i)
		}
		b.Write(l)
		block.AdvanceLine()
	}
	return b.String(), offsets
}

type textTagParser struct{}

func (textTagParser) Trigger() []byte { return []byte{'<'} }

func (textTagParser) Parse(parent gast.Node, block gtext.Reader, pc parser.Context) gast.Node {
	s, offsets := rest(block)
	if len(offsets) == 0 {
		return nil
	}
	sc := &scanner{s: s}
	tag, ok, err := sc.scanTag()
	if err != nil {
		record(pc, 2, offsets[0], err)
		return nil
	}
	if !ok {
		return nil
	}
	tag.start, tag.end = offsets[0], endOffset(offsets, sc.i)
	block.Advance(sc.i)
	return &textTagNode{tag: tag}
}

func endOffset(offsets []int, i int) int {
	if i < len(offsets) {
		return offsets[i]
	}
	return offsets[len(offsets)-1] + 1
}

type textExprParser struct{}

func (textExprParser) Trigger() []byte { return []byte{'{'} }

func (textExprParser) Parse(parent gast.Node, block gtext.Reader, pc parser.Context) gast.Node {
	s, offsets := rest(block)
	if len(offsets) == 0 {
		return nil
	}
	sc := &scanner{s: s}
	if _, err := sc.scanExpression(false, true); err != nil {
		record(pc, 2, offsets[0], err)
		return nil
	}
	n := &textExprNode{start: offsets[0], end: endOffset(offsets, sc.i)}
	block.Advance(sc.i)
	return n
}

func newMarkdown() goldmark.Markdown {
	tolerant := func(bp parser.BlockParser, priority int) util.PrioritizedValue {
		return util.Prioritized(indentTolerant{bp}, priority)
	}
	p := parser.NewParser(
		parser.WithBlockParsers(
			tolerant(parser.NewSetextHeadingParser(), 100),
			tolerant(parser.NewThematicBreakParser(), 200),
			util.Prioritized(parser.NewListParser(), 300),
			util.Prioritized(parser.NewListItemParser(), 400),
			tolerant(parser.NewATXHeadingParser(), 600),
			tolerant(parser.NewFencedCodeBlockParser(), 700),
			tolerant(parser.NewBlockquoteParser(), 800),
			util.Prioritized(flowParser{}, 850),
			util.Prioritized(esmParser{}, 860),
			tolerant(parser.NewParagraphParser(), 1000),
		),
		parser.WithInlineParsers(
			util.Prioritized(parser.NewCodeSpanParser(), 100),
			util.Prioritized(parser.NewLinkParser(), 200),
			util.Prioritized(textTagParser{}, 300),
			util.Prioritized(textExprParser{}, 310),
			util.Prioritized(parser.NewEmphasisParser(), 500),
			util.Prioritized(autolinkParser{}, 999),
		),
		parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
	)
	return goldmark.New(goldmark.WithParser(p), goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.TaskList, extension.Footnote))
}

var markdown = newMarkdown()

// ---------- positions ----------

type positions struct {
	src        []byte
	lineStarts []int
	original   func(int) int
}

func newPositions(src []byte, original func(int) int) *positions {
	p := &positions{src: src, lineStarts: []int{0}, original: original}
	for i := 0; i < len(src); i++ {
		if src[i] == '\n' || (src[i] == '\r' && (i+1 >= len(src) || src[i+1] != '\n')) {
			p.lineStarts = append(p.lineStarts, i+1)
		}
	}
	return p
}

// point formats an offset as micromark's line:column, counting UTF-16
// units (a tab is one column; its virtual spaces are not counted).
func (p *positions) point(offset int) string {
	offset = p.original(offset)
	line := sort.Search(len(p.lineStarts), func(i int) bool { return p.lineStarts[i] > offset }) - 1
	column := 1
	for i := p.lineStarts[line]; i < offset && i < len(p.src); {
		r, size := utf8.DecodeRune(p.src[i:])
		column++
		if r > 0xffff {
			column++
		}
		i += size
	}
	return itoa(line+1) + ":" + itoa(column)
}

func (p *positions) span(start, end int) string { return p.point(start) + "-" + p.point(end) }

func itoa(n int) string { return numberString(float64(n)) }

// ---------- mdast ----------

type mdNode struct {
	typ      string
	children []*mdNode
	value    string
	depth    int
	ordered  bool
	start    int
	spread   bool
	checked  int // -1 not a task, 0 unchecked, 1 checked
	lang     string
	url      string
	title    *string
	alt      *string
	align    []string
	ident    string
	name     string
	nameNull bool
	attrs    []jsxAttr

	unresolved bool // text whose escapes and character references are pending

	token      string // micromark token type, for error messages
	tag        *jsxTag
	posS, posE int
}

type structureError struct{ msg string }

type builder struct {
	src            []byte
	pos            *positions
	stack          []*mdNode
	tags           []*jsxTag
	footnoteLabels map[int]string
}

func (b *builder) top() *mdNode { return b.stack[len(b.stack)-1] }

func (b *builder) fail(msg string) { panic(&structureError{msg: msg}) }

func (b *builder) append(n *mdNode) {
	t := b.top()
	if n.typ == "text" && len(t.children) > 0 {
		if last := t.children[len(t.children)-1]; last.typ == "text" && last.unresolved == n.unresolved {
			last.value += n.value
			return
		}
	}
	t.children = append(t.children, n)
}

func (b *builder) enter(n *mdNode) {
	b.append(n)
	b.stack = append(b.stack, n)
}

func (b *builder) exit(n *mdNode) {
	if t := b.top(); t != n && t.tag != nil {
		b.rightIsTag(n)
	}
	b.stack = b.stack[:len(b.stack)-1]
}

func (b *builder) rightIsTag(closing *mdNode) {
	open := b.top()
	tag := b.tags[len(b.tags)-1]
	msg := "Expected a closing tag for `" + abbreviated(tag) + "` (" + b.pos.span(open.tag.start, open.tag.end) + ")"
	if closing != nil {
		msg += " before the end of `" + closing.token + "`"
	}
	b.fail(msg)
}

func (b *builder) addTag(t *jsxTag, flow bool) {
	if t.close {
		if len(b.tags) == 0 {
			b.fail("Unexpected closing slash `/` in tag, expected an open tag first")
		}
		if len(t.attrs) > 0 {
			b.fail("Unexpected attribute in closing tag, expected the end of the tag")
		}
		if t.selfClosing {
			b.fail("Unexpected self-closing slash `/` in closing tag, expected the end of the tag")
		}
		tail := b.tags[len(b.tags)-1]
		if tail.name != t.name {
			b.fail("Unexpected closing tag `" + abbreviated(t) + "`, expected corresponding closing tag for `" + abbreviated(tail) + "` (" + b.pos.span(tail.start, tail.end) + ")")
		}
		b.tags = b.tags[:len(b.tags)-1]
		if open := b.top(); open.tag != tail {
			b.fail("Expected the closing tag `" + abbreviated(t) + "` either after the end of `" + open.token +
				"` (" + b.pos.point(open.posE) + ") or another opening tag after the start of `" + open.token + "` (" + b.pos.point(open.posS) + ")")
		}
		b.stack = b.stack[:len(b.stack)-1]
		return
	}
	typ := "mdxJsxTextElement"
	if flow {
		typ = "mdxJsxFlowElement"
	}
	n := &mdNode{typ: typ, name: t.name, nameNull: t.name == "", attrs: t.attrs, tag: t, token: typ, posS: t.start, posE: t.end}
	b.enter(n)
	if t.selfClosing {
		b.stack = b.stack[:len(b.stack)-1]
		return
	}
	b.tags = append(b.tags, t)
}

// span computes a node's source range from its lines or descendants.
func span(n gast.Node) (int, int) {
	start, end := -1, -1
	grow := func(s, e int) {
		if start < 0 || s < start {
			start = s
		}
		if e > end {
			end = e
		}
	}
	var walk func(gast.Node)
	walk = func(n gast.Node) {
		switch x := n.(type) {
		case *gast.Text:
			grow(x.Segment.Start, x.Segment.Stop)
		case *textTagNode:
			grow(x.tag.start, x.tag.end)
		case *textExprNode:
			grow(x.start, x.end)
		}
		if n.Type() == gast.TypeBlock {
			if lines := n.Lines(); lines != nil && lines.Len() > 0 {
				grow(lines.At(0).Start, lines.At(lines.Len()-1).Stop)
			}
		}
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			walk(c)
		}
	}
	walk(n)
	if start < 0 {
		return 0, 0
	}
	return start, end
}

// emptyTask reports a checkbox with nothing after it, which GFM does not
// treat as a task; the marker is put back as text.
func (b *builder) emptyTask(paragraph gast.Node, box gast.Node) bool {
	next := box.NextSibling()
	if next != nil {
		if t, ok := next.(*gast.Text); !ok || len(bytes.TrimSpace(t.Segment.Value(b.src))) > 0 || t.NextSibling() != nil {
			return false
		}
	}
	lines := paragraph.Lines()
	if lines.Len() == 0 {
		return false
	}
	first := lines.At(0)
	line := bytes.TrimLeft(first.Value(b.src), " \t")
	if len(line) < 3 {
		return false
	}
	paragraph.RemoveChild(paragraph, box)
	for paragraph.FirstChild() != nil {
		paragraph.RemoveChild(paragraph, paragraph.FirstChild())
	}
	paragraph.AppendChild(paragraph, gast.NewString(line[:3]))
	return true
}

// lineEnding returns the line ending at or after offset, past trailing
// spaces, so text keeps CRLF the way micromark does.
func (b *builder) lineEnding(offset int) string {
	for offset < len(b.src) && (b.src[offset] == ' ' || b.src[offset] == '\t') {
		offset++
	}
	if bytes.HasPrefix(b.src[offset:], []byte("\r\n")) {
		return "\r\n"
	}
	if offset < len(b.src) && b.src[offset] == '\r' {
		return "\r"
	}
	return "\n"
}

func (b *builder) inlineText(n gast.Node, resolve bool) string {
	var s strings.Builder
	var walk func(gast.Node)
	walk = func(n gast.Node) {
		switch x := n.(type) {
		case *gast.Text:
			v := string(x.Segment.Value(b.src))
			if resolve {
				v = resolveText(v)
			}
			s.WriteString(v)
			if x.SoftLineBreak() || x.HardLineBreak() {
				s.WriteByte('\n')
			}
			return
		case *gast.String:
			s.Write(x.Value)
			return
		case *gast.AutoLink:
			s.Write(x.Label(b.src))
			return
		}
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			walk(c)
		}
	}
	walk(n)
	return s.String()
}

var alignNames = map[east.Alignment]string{east.AlignLeft: "left", east.AlignRight: "right", east.AlignCenter: "center"}

func (b *builder) children(n gast.Node) {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.node(c)
	}
}

func (b *builder) container(m *mdNode, n gast.Node) {
	m.posS, m.posE = span(n)
	b.enter(m)
	b.children(n)
	b.exit(m)
}

func (b *builder) node(n gast.Node) {
	switch x := n.(type) {
	case *gast.Paragraph, *gast.TextBlock:
		if n.Lines().Len() == 0 && !n.HasChildren() {
			return // a paragraph that held only link definitions
		}
		b.container(&mdNode{typ: "paragraph", token: "paragraph"}, n)
	case *gast.Heading:
		token := "atxHeading"
		b.container(&mdNode{typ: "heading", depth: x.Level, token: token}, n)
	case *gast.ThematicBreak:
		b.append(&mdNode{typ: "thematicBreak"})
	case *gast.Blockquote:
		b.container(&mdNode{typ: "blockquote", token: "blockQuote"}, n)
	case *gast.List:
		token := "listUnordered"
		if x.IsOrdered() {
			token = "listOrdered"
		}
		b.container(&mdNode{typ: "list", ordered: x.IsOrdered(), start: x.Start, spread: !x.IsTight, token: token}, n)
	case *gast.ListItem:
		m := &mdNode{typ: "listItem", checked: -1, token: "listItem"}
		if first := x.FirstChild(); first != nil {
			if box, ok := first.FirstChild().(*east.TaskCheckBox); ok && !b.emptyTask(first, box) {
				m.checked = 0
				if box.IsChecked {
					m.checked = 1
				}
				first.RemoveChild(first, box)
				if t, ok := first.FirstChild().(*gast.Text); ok {
					t.Segment = t.Segment.TrimLeftSpace(b.src)
				}
			}
		}
		m.posS, m.posE = span(n)
		// The listItem token starts at the marker, not the content.
		start := m.posS
		for start > 0 && b.src[start-1] != '\n' {
			start--
		}
		for start < m.posS && (b.src[start] == ' ' || b.src[start] == '\t') {
			start++
		}
		b.enter(m)
		m.posS = start
		b.children(n)
		b.exit(m)
	case *gast.FencedCodeBlock:
		m := &mdNode{typ: "code", token: "codeFenced"}
		if x.Info != nil {
			info := decodeEntities(unescapePunct(string(x.Info.Segment.Value(b.src))))
			m.lang, _, _ = strings.Cut(strings.TrimSpace(info), " ")
			if i := strings.IndexAny(m.lang, " \t"); i >= 0 {
				m.lang = m.lang[:i]
			}
		}
		var v strings.Builder
		lines := x.Lines()
		for i := 0; i < lines.Len(); i++ {
			seg := lines.At(i)
			v.WriteString(strings.Repeat(" ", seg.Padding))
			v.Write(seg.Value(b.src))
		}
		m.value = strings.TrimSuffix(v.String(), "\n")
		b.append(m)
	case *east.Table:
		m := &mdNode{typ: "table", token: "table"}
		for _, a := range x.Alignments {
			m.align = append(m.align, alignNames[a])
		}
		b.container(m, n)
	case *east.TableHeader, *east.TableRow:
		b.container(&mdNode{typ: "tableRow", token: "tableRow"}, n)
	case *east.TableCell:
		token := "tableData"
		if _, header := x.Parent().(*east.TableHeader); header {
			token = "tableHeader"
		}
		b.container(&mdNode{typ: "tableCell", token: token}, n)
	case *gast.Text:
		value := string(x.Segment.Value(b.src))
		if x.SoftLineBreak() {
			value += b.lineEnding(x.Segment.Stop)
		}
		b.append(&mdNode{typ: "text", value: value, unresolved: true})
		if x.HardLineBreak() {
			b.append(&mdNode{typ: "break"})
		}
	case *gast.String:
		b.append(&mdNode{typ: "text", value: string(x.Value), unresolved: true})
	case *gast.Emphasis:
		if x.Level == 2 {
			b.container(&mdNode{typ: "strong", token: "strong"}, n)
		} else {
			b.container(&mdNode{typ: "emphasis", token: "emphasis"}, n)
		}
	case *east.Strikethrough:
		b.container(&mdNode{typ: "delete", token: "strikethrough"}, n)
	case *gast.CodeSpan:
		b.append(&mdNode{typ: "inlineCode", value: b.inlineText(n, false)})
	case *gast.Link:
		m := &mdNode{typ: "link", url: resolveText(string(x.Destination)), token: "link"}
		if x.Title != nil {
			t := resolveText(string(x.Title))
			m.title = &t
		}
		b.container(m, n)
	case *gast.Image:
		alt := b.inlineText(n, true)
		m := &mdNode{typ: "image", url: resolveText(string(x.Destination)), alt: &alt}
		b.append(m)
	case *gast.AutoLink:
		url := string(x.URL(b.src))
		if x.AutoLinkType == gast.AutoLinkEmail && !strings.HasPrefix(strings.ToLower(url), "mailto:") {
			url = "mailto:" + url
		}
		m := &mdNode{typ: "link", url: url, token: "link"}
		b.enter(m)
		b.append(&mdNode{typ: "text", value: string(x.Label(b.src))})
		b.exit(m)
	case *literalLinkNode:
		m := &mdNode{typ: "link", url: x.url, token: "literalAutolink"}
		b.enter(m)
		b.append(&mdNode{typ: "text", value: x.text})
		b.exit(m)
	case *east.FootnoteLink:
		b.append(&mdNode{typ: "footnoteReference", ident: b.footnoteLabels[x.Index]})
	case *east.FootnoteList:
		// Definitions render in the footer, from footnoteDefinitions.
	case *flowNode:
		for _, item := range x.items {
			if item.tag != nil {
				b.addTag(item.tag, true)
			} else {
				b.append(&mdNode{typ: "mdxFlowExpression", posS: item.start, posE: item.end})
			}
		}
	case *esmNode:
		b.append(&mdNode{typ: "mdxjsEsm"})
	case *textTagNode:
		b.addTag(x.tag, false)
	case *textExprNode:
		b.append(&mdNode{typ: "mdxTextExpression"})
	default:
		b.children(n)
	}
}

var characterReference = regexp.MustCompile(`^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});`)

// resolveText applies backslash escapes and character references, which
// goldmark leaves in text segments for its renderer.
func resolveText(s string) string {
	if !strings.ContainsAny(s, "\\&\x00") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s) && util.IsPunct(s[i+1]):
			i++
			b.WriteByte(s[i])
		case c == '&':
			if m := characterReference.FindString(s[i:]); m != "" {
				if m[1] == '#' {
					b.WriteString(decodeNumericReference(m))
					i += len(m) - 1
					continue
				}
				if v := html.UnescapeString(m); v != m && utf8.RuneCountInString(v) <= 2 {
					b.WriteString(v)
					i += len(m) - 1
					continue
				}
			}
			b.WriteByte(c)
		case c == 0:
			b.WriteString("\uFFFD")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// decodeNumericReference is micromark's decodeNumericCharacterReference.
func decodeNumericReference(ref string) string {
	digits, base := ref[2:len(ref)-1], 10
	if digits[0] == 'x' || digits[0] == 'X' {
		digits, base = digits[1:], 16
	}
	n, _ := strconv.ParseInt(digits, base, 64)
	if n < 9 || n == 11 || (n > 13 && n < 32) || (n > 126 && n < 160) || (n > 55295 && n < 57344) ||
		(n > 64975 && n < 65008) || n&65535 == 65535 || n&65535 == 65534 || n > 1114111 {
		return "\uFFFD"
	}
	return string(rune(n))
}

func unescapePunct(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && util.IsPunct(s[i+1]) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

type parsedMdx struct {
	root        *mdNode
	footnotes   map[string]*mdNode
	parseError  string
	sourceIsMdx bool
}

// parseMdx parses source into an mdast tree, or reports the first error the
// TypeScript parser would throw.
func parseMdx(source string) (result parsedMdx) {
	d := dedent(source)
	src := []byte(d.source)
	pc := parser.NewContext()
	st := &parseState{source: src}
	pc.Set(stateKey, st)
	doc := markdown.Parser().Parse(gtext.NewReader(src), parser.WithContext(pc))
	if len(st.errs) > 0 {
		sort.SliceStable(st.errs, func(i, j int) bool {
			a, b := st.errs[i], st.errs[j]
			if a.phase != b.phase {
				return a.phase < b.phase
			}
			return a.offset < b.offset
		})
		result.parseError = st.errs[0].msg
		return result
	}
	b := &builder{src: src, pos: newPositions([]byte(source), d.original), footnoteLabels: map[int]string{}}
	root := &mdNode{typ: "root"}
	b.stack = []*mdNode{root}
	footnotes := map[string]*mdNode{}
	var lists []*east.FootnoteList
	gast.Walk(doc, func(n gast.Node, entering bool) (gast.WalkStatus, error) {
		if entering {
			if fl, ok := n.(*east.FootnoteList); ok {
				lists = append(lists, fl)
				for c := fl.FirstChild(); c != nil; c = c.NextSibling() {
					if f, ok := c.(*east.Footnote); ok {
						b.footnoteLabels[f.Index] = normalizeLabel(string(f.Ref))
					}
				}
			}
		}
		return gast.WalkContinue, nil
	})
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(*structureError)
			if !ok {
				panic(r)
			}
			result = parsedMdx{parseError: e.msg}
		}
	}()
	b.children(doc)
	if len(b.stack) > 1 {
		if t := b.top(); t.tag != nil {
			b.rightIsTag(nil)
		}
	}
	for _, fl := range lists {
		for c := fl.FirstChild(); c != nil; c = c.NextSibling() {
			f, ok := c.(*east.Footnote)
			if !ok {
				continue
			}
			def := &mdNode{typ: "footnoteDefinition", ident: normalizeLabel(string(f.Ref))}
			b.stack = []*mdNode{def}
			for d := f.FirstChild(); d != nil; d = d.NextSibling() {
				if _, back := d.(*east.FootnoteBacklink); back {
					continue
				}
				b.node(d)
			}
			footnotes[strings.ToUpper(def.ident)] = def
		}
	}
	resolveAll(root)
	for _, def := range footnotes {
		resolveAll(def)
	}
	return parsedMdx{root: root, footnotes: footnotes}
}

// resolveAll applies escapes and character references once adjacent goldmark
// text segments have merged, so references split across segments decode.
func resolveAll(n *mdNode) {
	if n.unresolved {
		n.value, n.unresolved = resolveText(n.value), false
	}
	for _, c := range n.children {
		resolveAll(c)
	}
}

func normalizeLabel(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
