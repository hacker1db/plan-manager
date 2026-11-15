package mdxrender

import (
	"net/url"
	"regexp"
	"strings"
	"unicode/utf16"
)

// A port of mdast-util-to-hast (as configured by react-markdown) producing
// HTML nodes, with render.tsx's handlers for MDX nodes. JSX elements become
// placeholders that render.go resolves against the block registry.

type hAttr struct{ name, value string }

type hNode struct {
	isText   bool
	text     string
	tag      string
	attrs    []hAttr
	children []*hNode
	record   *blockRecord // placeholder for a block
}

func txt(s string) *hNode { return &hNode{isText: true, text: s} }

func el(tag string, attrs []hAttr, children ...*hNode) *hNode {
	return &hNode{tag: tag, attrs: attrs, children: children}
}

func attrs(pairs ...string) []hAttr {
	var out []hAttr
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, hAttr{pairs[i], pairs[i+1]})
	}
	return out
}

type blockRecord struct {
	index       int
	name        string
	props       *object
	inline      bool
	parent      string
	parentIndex int
	err         string
	tabs        []string
}

var (
	inlineHTML = setOf("abbr", "b", "br", "code", "em", "i", "kbd", "mark", "s", "small", "span", "strong", "sub", "sup", "u")
	flowHTML   = setOf("abbr", "b", "br", "code", "em", "i", "kbd", "mark", "s", "small", "span", "strong", "sub", "sup", "u", "details", "div", "hr", "p", "summary")
	aliases    = map[string]string{
		"ApiEndpoint":  "Endpoint",
		"Diagram":      "Flow or Layers",
		"FileMap":      "FileTree",
		"Mermaid":      "Flow or Layers",
		"QuestionForm": "Questions",
		"RichText":     "plain Markdown",
		"TabsBlock":    "Tabs",
	}
)

func setOf(items ...string) map[string]bool {
	m := map[string]bool{}
	for _, i := range items {
		m[i] = true
	}
	return m
}

func unknownBlockMessage(name string) string {
	match := ""
	for _, b := range Blocks {
		if strings.ToLower(b.Name) == strings.ToLower(name) {
			match = b.Name
			break
		}
	}
	if match == "" {
		match = aliases[name]
	}
	if match == "" {
		return "Unknown block <" + name + ">"
	}
	if !strings.Contains(match, " ") {
		match = "<" + match + ">"
	}
	return "Unknown block <" + name + "> — did you mean " + match + "?"
}

type toHast struct {
	records        []*blockRecord
	stack          []*blockRecord
	footnotes      map[string]*mdNode
	footnoteOrder  []string
	footnoteCounts map[string]int
}

func (s *toHast) placeholder(r *blockRecord, children []*hNode) *hNode {
	return &hNode{record: r, children: children}
}

func (s *toHast) failure(inline bool, message string) []*hNode {
	r := &blockRecord{index: len(s.records), inline: inline, parentIndex: -1, err: message}
	s.records = append(s.records, r)
	return []*hNode{s.placeholder(r, nil)}
}

var lowercaseStart = regexp.MustCompile(`^[a-z]`)

func (s *toHast) jsx(n *mdNode, flow bool) []*hNode {
	if n.nameNull {
		return s.all(n)
	}
	name := n.name
	if lowercaseStart.MatchString(name) {
		allowed := inlineHTML
		if flow {
			allowed = flowHTML
		}
		if !allowed[name] {
			return s.all(n)
		}
		return []*hNode{el(name, nil, s.all(n)...)}
	}
	r := &blockRecord{index: len(s.records), name: name, props: newObject(), inline: !flow, parentIndex: -1}
	if len(s.stack) > 0 {
		parent := s.stack[len(s.stack)-1]
		r.parent, r.parentIndex = parent.name, parent.index
	}
	s.records = append(s.records, r)
	spec := blockByName(name)
	switch {
	case spec == nil:
		r.err = unknownBlockMessage(name)
	case !flow:
		r.err = "<" + name + "> is a block: put its opening and closing tags on their own lines"
	case spec.Parent != "" && r.parent != spec.Parent:
		r.err = "<" + name + "> is only valid inside <" + spec.Parent + ">"
	default:
		props, err := staticProps(n.attrs)
		if err != nil {
			r.err = "<" + name + ">: " + err.Error()
			break
		}
		r.props = props
		if problems := validateBlockProps(spec, props); len(problems) > 0 {
			r.err = "<" + name + ">: " + strings.Join(problems, "; ")
		}
	}
	if r.err == "" && spec != nil && spec.Children != "markdown" && spec.Children != "none" {
		for _, child := range n.children {
			if child.typ != "mdxJsxFlowElement" || child.name != spec.Children {
				r.err = "<" + name + "> may only contain <" + spec.Children + "> elements"
				break
			}
		}
	}
	s.stack = append(s.stack, r)
	var children []*hNode
	if r.err == "" {
		children = s.all(n)
	}
	s.stack = s.stack[:len(s.stack)-1]
	if name == "Tabs" {
		r.tabs = []string{}
		for _, child := range s.records {
			if child.parentIndex == r.index && child.name == "Tab" {
				r.tabs = append(r.tabs, jsString(nullish(child.props.field("label"), "")))
			}
		}
	}
	return []*hNode{s.placeholder(r, children)}
}

func (s *toHast) all(parent *mdNode) []*hNode {
	var values []*hNode
	for i, child := range parent.children {
		result := s.one(child, parent)
		if len(result) == 0 {
			continue
		}
		if i > 0 && parent.children[i-1].typ == "break" {
			if len(result) == 1 {
				if head := result[0]; head.isText {
					head.text = strings.TrimLeft(head.text, " \t")
				} else if len(head.children) > 0 && head.children[0].isText {
					head.children[0].text = strings.TrimLeft(head.children[0].text, " \t")
				}
			}
		}
		values = append(values, result...)
	}
	return values
}

func wrap(nodes []*hNode, loose bool) []*hNode {
	var result []*hNode
	if loose {
		result = append(result, txt("\n"))
	}
	for i, n := range nodes {
		if i > 0 {
			result = append(result, txt("\n"))
		}
		result = append(result, n)
	}
	if loose && len(nodes) > 0 {
		result = append(result, txt("\n"))
	}
	return result
}

var lineTrim = regexp.MustCompile(`[ \t]*(\r?\n|\r)[ \t]*`)

// trimLines removes spaces and tabs around line endings, keeping the
// leading and trailing whitespace of the whole value.
func trimLines(v string) string {
	return lineTrim.ReplaceAllString(v, "$1")
}

func listLoose(list *mdNode) bool {
	if list.spread {
		return true
	}
	for _, item := range list.children {
		if item.spread {
			return true
		}
	}
	return false
}

func (s *toHast) one(n *mdNode, parent *mdNode) []*hNode {
	switch n.typ {
	case "root":
		return wrap(s.all(n), false)
	case "paragraph":
		return []*hNode{el("p", nil, s.all(n)...)}
	case "heading":
		return []*hNode{el("h"+itoa(n.depth), nil, s.all(n)...)}
	case "thematicBreak":
		return []*hNode{el("hr", nil)}
	case "blockquote":
		return []*hNode{el("blockquote", nil, wrap(s.all(n), true)...)}
	case "list":
		var a []hAttr
		if n.ordered && n.start != 1 {
			a = append(a, hAttr{"start", itoa(n.start)})
		}
		results := s.all(n)
		for _, r := range results {
			if r.tag == "li" && len(r.attrs) > 0 && r.attrs[0].name == "class" {
				a = append(a, hAttr{"class", "contains-task-list"})
				break
			}
		}
		tag := "ul"
		if n.ordered {
			tag = "ol"
		}
		return []*hNode{el(tag, a, wrap(results, true)...)}
	case "listItem":
		return []*hNode{s.listItem(n, parent)}
	case "code":
		value := ""
		if n.value != "" {
			value = n.value + "\n"
		}
		var a []hAttr
		if lang := strings.Fields(n.lang); len(lang) > 0 {
			a = attrs("class", "language-"+lang[0])
		}
		return []*hNode{el("pre", nil, el("code", a, txt(value)))}
	case "text":
		return []*hNode{txt(trimLines(n.value))}
	case "emphasis":
		return []*hNode{el("em", nil, s.all(n)...)}
	case "strong":
		return []*hNode{el("strong", nil, s.all(n)...)}
	case "delete":
		return []*hNode{el("del", nil, s.all(n)...)}
	case "inlineCode":
		v := strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(n.value)
		return []*hNode{el("code", nil, txt(v))}
	case "break":
		return []*hNode{el("br", nil), txt("\n")}
	case "link":
		a := attrs("href", urlTransform(normalizeURI(n.url)))
		if n.title != nil {
			a = append(a, hAttr{"title", *n.title})
		}
		return []*hNode{el("a", a, s.all(n)...)}
	case "image":
		// react-markdown maps img to <span>{alt}</span>; the image never loads.
		alt := []*hNode{}
		if n.alt != nil && *n.alt != "" {
			alt = append(alt, txt(*n.alt))
		}
		return []*hNode{el("span", nil, alt...)}
	case "table":
		return []*hNode{s.table(n)}
	case "footnoteReference":
		return []*hNode{s.footnoteReference(n)}
	case "mdxJsxFlowElement":
		return s.jsx(n, true)
	case "mdxJsxTextElement":
		return s.jsx(n, false)
	case "mdxjsEsm":
		return s.failure(false, "import and export statements are not supported in plans")
	case "mdxFlowExpression":
		return s.failure(false, `{expressions} are not supported in plans; escape braces as \{ or use a code span`)
	case "mdxTextExpression":
		return s.failure(true, "{expressions} are not supported in plans")
	}
	return s.all(n)
}

func taskInput(checked bool) *hNode {
	a := attrs("type", "checkbox", "disabled", "", "data-plan-task", "true")
	if checked {
		a = append(a, hAttr{"checked", ""})
	}
	return el("input", a)
}

func (s *toHast) listItem(n, parent *mdNode) *hNode {
	results := s.all(n)
	loose := listLoose(parent)
	var a []hAttr
	if n.checked >= 0 {
		var paragraph *hNode
		if len(results) > 0 && results[0].tag == "p" && results[0].record == nil {
			paragraph = results[0]
		} else {
			paragraph = el("p", nil)
			results = append([]*hNode{paragraph}, results...)
		}
		if len(paragraph.children) > 0 {
			paragraph.children = append([]*hNode{txt(" ")}, paragraph.children...)
		}
		paragraph.children = append([]*hNode{taskInput(n.checked == 1)}, paragraph.children...)
		a = attrs("class", "task-list-item")
	}
	var children []*hNode
	isP := func(h *hNode) bool { return !h.isText && h.record == nil && h.tag == "p" }
	for i, child := range results {
		if loose || i != 0 || !isP(child) {
			children = append(children, txt("\n"))
		}
		if isP(child) && !loose {
			children = append(children, child.children...)
		} else {
			children = append(children, child)
		}
	}
	if len(results) > 0 {
		if tail := results[len(results)-1]; loose || !isP(tail) {
			children = append(children, txt("\n"))
		}
	}
	return el("li", a, children...)
}

func (s *toHast) table(n *mdNode) *hNode {
	var rows []*hNode
	for i, row := range n.children {
		tag := "td"
		if i == 0 {
			tag = "th"
		}
		length := len(n.align)
		if n.align == nil {
			length = len(row.children)
		}
		var cells []*hNode
		for c := 0; c < length; c++ {
			var a []hAttr
			if c < len(n.align) && n.align[c] != "" {
				a = attrs("style", "text-align:"+n.align[c])
			}
			cell := el(tag, a)
			if c < len(row.children) {
				cell.children = s.all(row.children[c])
			}
			cells = append(cells, cell)
		}
		rows = append(rows, el("tr", nil, wrap(cells, true)...))
	}
	var content []*hNode
	if len(rows) > 0 {
		content = append(content, el("thead", nil, wrap(rows[:1], true)...))
	}
	if len(rows) > 1 {
		content = append(content, el("tbody", nil, wrap(rows[1:], true)...))
	}
	return el("table", nil, wrap(content, true)...)
}

const clobberPrefix = "user-content-"

func (s *toHast) footnoteReference(n *mdNode) *hNode {
	id := strings.ToUpper(n.ident)
	safeID := normalizeURI(strings.ToLower(id))
	index := -1
	for i, o := range s.footnoteOrder {
		if o == id {
			index = i
		}
	}
	reuse, seen := s.footnoteCounts[id]
	counter := index + 1
	if !seen {
		s.footnoteOrder = append(s.footnoteOrder, id)
		counter = len(s.footnoteOrder)
	}
	reuse++
	s.footnoteCounts[id] = reuse
	refID := clobberPrefix + "fnref-" + safeID
	if reuse > 1 {
		refID += "-" + itoa(reuse)
	}
	link := el("a", attrs("href", "#"+clobberPrefix+"fn-"+safeID, "id", refID, "data-footnote-ref", "true", "aria-describedby", "footnote-label"), txt(itoa(counter)))
	return el("sup", nil, link)
}

func (s *toHast) footer() *hNode {
	var items []*hNode
	for referenceIndex, id := range s.footnoteOrder {
		def := s.footnotes[id]
		if def == nil {
			continue
		}
		content := s.all(def)
		safeID := normalizeURI(strings.ToLower(strings.ToUpper(def.ident)))
		var backs []*hNode
		for re := 1; re <= s.footnoteCounts[id]; re++ {
			if len(backs) > 0 {
				backs = append(backs, txt(" "))
			}
			href := "#" + clobberPrefix + "fnref-" + safeID
			label := "Back to reference " + itoa(referenceIndex+1)
			children := []*hNode{txt("↩")}
			if re > 1 {
				href += "-" + itoa(re)
				label += "-" + itoa(re)
				children = append(children, el("sup", nil, txt(itoa(re))))
			}
			backs = append(backs, el("a", attrs("href", href, "data-footnote-backref", "", "aria-label", label, "class", "data-footnote-backref"), children...))
		}
		if n := len(content); n > 0 && content[n-1].tag == "p" && content[n-1].record == nil {
			tail := content[n-1]
			if m := len(tail.children); m > 0 && tail.children[m-1].isText {
				tail.children[m-1].text += " "
			} else {
				tail.children = append(tail.children, txt(" "))
			}
			tail.children = append(tail.children, backs...)
		} else {
			content = append(content, backs...)
		}
		items = append(items, el("li", attrs("id", clobberPrefix+"fn-"+safeID), wrap(content, true)...))
	}
	if len(items) == 0 {
		return nil
	}
	return el("section", attrs("data-footnotes", "true", "class", "footnotes"),
		el("h2", attrs("class", "sr-only", "id", "footnote-label"), txt("Footnotes")),
		txt("\n"),
		el("ol", nil, wrap(items, true)...),
		txt("\n"),
	)
}

// normalizeURI is micromark-util-sanitize-uri's normalizeUri: percent-encode
// characters outside the URL-safe set, keeping existing escapes.
func normalizeURI(v string) string {
	units := utf16.Encode([]rune(v))
	var b strings.Builder
	for i := 0; i < len(units); i++ {
		c := units[i]
		if c == '%' && i+2 < len(units) && isASCIIAlnum(units[i+1]) && isASCIIAlnum(units[i+2]) {
			b.WriteString(string(utf16.Decode(units[i : i+3])))
			i += 2
			continue
		}
		var replace string
		switch {
		case c < 128:
			if !urlSafe(byte(c)) {
				replace = string(rune(c))
			}
		case c >= 0xd800 && c < 0xe000:
			if c < 0xdc00 && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] < 0xe000 {
				replace = string(utf16.Decode(units[i : i+2]))
				i++
			} else {
				replace = "�"
			}
		default:
			replace = string(rune(c))
		}
		if replace != "" {
			b.WriteString(encodeURIComponent(replace))
			continue
		}
		b.WriteByte(byte(c))
	}
	return b.String()
}

func isASCIIAlnum(c uint16) bool {
	return c < 128 && (c >= '0' && c <= '9' || c|0x20 >= 'a' && c|0x20 <= 'z')
}

// urlSafe is /[!#$&-;=?-Z_a-z~]/.
func urlSafe(c byte) bool {
	return c == '!' || c == '#' || c == '$' || (c >= '&' && c <= ';') || c == '=' || (c >= '?' && c <= 'Z') || c == '_' || (c >= 'a' && c <= 'z') || c == '~'
}

func encodeURIComponent(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	for _, keep := range []string{"!", "'", "(", ")", "*"} {
		e = strings.ReplaceAll(e, url.QueryEscape(keep), keep)
	}
	return e
}

var safeProtocol = regexp.MustCompile(`(?i)^(https?|ircs?|mailto|xmpp)$`)

// urlTransform is react-markdown's defaultUrlTransform.
func urlTransform(v string) string {
	colon := strings.IndexByte(v, ':')
	question := strings.IndexByte(v, '?')
	hash := strings.IndexByte(v, '#')
	slash := strings.IndexByte(v, '/')
	if colon < 0 || (slash >= 0 && colon > slash) || (question >= 0 && colon > question) || (hash >= 0 && colon > hash) || safeProtocol.MatchString(v[:colon]) {
		return v
	}
	return ""
}
