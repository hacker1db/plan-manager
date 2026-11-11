package mdxrender

import (
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Block components from render.tsx, producing the same markup React's
// renderToStaticMarkup does, plus the serializer.

// ---------- shared helpers ----------

func asRecord(v value) *object {
	if o, ok := v.(*object); ok {
		return o
	}
	return newObject()
}

func asArray(v value) []value {
	if a, ok := v.(*array); ok {
		return a.items
	}
	return nil
}

func isChange(v value) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, c := range changeValues {
		if c == s {
			return true
		}
	}
	return false
}

func changeBadge(change value) *hNode {
	if !isChange(change) {
		return nil
	}
	c := change.(string)
	return el("span", attrs("class", "pm-change pm-change-"+c), txt(c))
}

func blockTitle(title, summary value) *hNode {
	if !truthy(title) && !truthy(summary) {
		return nil
	}
	head := el("header", attrs("class", "pm-block-head"))
	if truthy(title) {
		head.children = append(head.children, el("h4", attrs("class", "pm-block-title"), txt(text(title))))
	}
	if truthy(summary) {
		head.children = append(head.children, el("p", attrs("class", "pm-block-summary"), txt(text(summary))))
	}
	return head
}

func blockError(message string, inline bool) *hNode {
	if inline {
		return el("span", attrs("class", "pm-block-error", "role", "note"), txt(message))
	}
	return el("div", attrs("class", "pm-block-error", "role", "note"), el("strong", nil, txt("Plan block error")), el("span", nil, txt(message)))
}

func fragment(children ...*hNode) *hNode { return &hNode{children: children} }

func splitLines(v value) []string {
	source := strings.ReplaceAll(text(v), "\r\n", "\n")
	if source == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(source, "\n"), "\n")
}

type annotation struct {
	line int
	note string
	side string
}

func annotations(v value) []annotation {
	var out []annotation
	for _, item := range asArray(v) {
		r := asRecord(item)
		line := r.field("line")
		if !isInteger(line) || !truthy(r.field("note")) {
			continue
		}
		side := "after"
		if s, ok := r.field("side").(string); ok && s == "before" {
			side = "before"
		}
		out = append(out, annotation{line: int(line.(float64)), note: text(r.field("note")), side: side})
	}
	return out
}

func notesFor(list []annotation, side string, line int) []annotation {
	if line == 0 {
		return nil
	}
	var out []annotation
	for _, a := range list {
		if a.side == side && a.line == line {
			out = append(out, a)
		}
	}
	return out
}

func lineNumber(n int) *hNode {
	if n == 0 {
		return nil
	}
	return txt(itoa(n))
}

// ---------- line diff ----------

type diffOp struct {
	kind          string // same, del, add
	text          string
	before, after int // 0 when absent
}

func diffLines(before, after []string) []diffOp {
	start := 0
	for start < len(before) && start < len(after) && before[start] == after[start] {
		start++
	}
	endBefore, endAfter := len(before), len(after)
	for endBefore > start && endAfter > start && before[endBefore-1] == after[endAfter-1] {
		endBefore--
		endAfter--
	}
	a, b := before[start:endBefore], after[start:endAfter]
	var middle []diffOp
	if len(a)*len(b) > 4_000_000 {
		for _, line := range a {
			middle = append(middle, diffOp{kind: "del", text: line})
		}
		for _, line := range b {
			middle = append(middle, diffOp{kind: "add", text: line})
		}
	} else {
		width := len(b) + 1
		table := make([]uint32, (len(a)+1)*width)
		for i := len(a) - 1; i >= 0; i-- {
			for j := len(b) - 1; j >= 0; j-- {
				if a[i] == b[j] {
					table[i*width+j] = table[(i+1)*width+j+1] + 1
				} else {
					table[i*width+j] = max(table[(i+1)*width+j], table[i*width+j+1])
				}
			}
		}
		i, j := 0, 0
		for i < len(a) || j < len(b) {
			switch {
			case i < len(a) && j < len(b) && a[i] == b[j]:
				middle = append(middle, diffOp{kind: "same", text: a[i]})
				i++
				j++
			case i < len(a) && (j == len(b) || table[(i+1)*width+j] >= table[i*width+j+1]):
				middle = append(middle, diffOp{kind: "del", text: a[i]})
				i++
			default:
				middle = append(middle, diffOp{kind: "add", text: b[j]})
				j++
			}
		}
	}
	var ops []diffOp
	for _, line := range before[:start] {
		ops = append(ops, diffOp{kind: "same", text: line})
	}
	ops = append(ops, middle...)
	for _, line := range before[endBefore:] {
		ops = append(ops, diffOp{kind: "same", text: line})
	}
	beforeLine, afterLine := 0, 0
	for i := range ops {
		if ops[i].kind != "add" {
			beforeLine++
			ops[i].before = beforeLine
		}
		if ops[i].kind != "del" {
			afterLine++
			ops[i].after = afterLine
		}
	}
	return ops
}

func noteRow(notes []annotation, span int) *hNode {
	if len(notes) == 0 {
		return nil
	}
	cell := el("td", attrs("colSpan", itoa(span)))
	for _, n := range notes {
		cell.children = append(cell.children, el("p", nil, txt(n.note)))
	}
	return el("tr", attrs("class", "pm-note-row"), cell)
}

func codeHead(props *object) *hNode {
	head := el("figcaption", attrs("class", "pm-code-head"), el("code", nil, txt(text(props.field("filename")))))
	if truthy(props.field("language")) {
		head.children = append(head.children, el("span", attrs("class", "pm-lang"), txt(text(props.field("language")))))
	}
	return head
}

func summaryLine(props *object) *hNode {
	if !truthy(props.field("summary")) {
		return nil
	}
	return el("p", attrs("class", "pm-block-summary"), txt(text(props.field("summary"))))
}

func renderDiff(props *object) *hNode {
	ops := diffLines(splitLines(props.field("before")), splitLines(props.field("after")))
	notes := annotations(props.field("annotations"))
	split := props.field("mode") != "unified"
	added, removed := 0, 0
	for _, op := range ops {
		switch op.kind {
		case "add":
			added++
		case "del":
			removed++
		}
	}
	var rows []*hNode
	td := func(class string, children ...*hNode) *hNode { return el("td", attrs("class", class), children...) }
	if split {
		for index := 0; index < len(ops); {
			if ops[index].kind == "same" {
				op := ops[index]
				index++
				rows = append(rows, el("tr", nil, td("pm-ln", lineNumber(op.before)), td("pm-code", txt(op.text)), td("pm-ln", lineNumber(op.after)), td("pm-code", txt(op.text))))
				rows = append(rows, noteRow(append(notesFor(notes, "before", op.before), notesFor(notes, "after", op.after)...), 4))
				continue
			}
			var dels, adds []diffOp
			for index < len(ops) && ops[index].kind != "same" {
				if ops[index].kind == "del" {
					dels = append(dels, ops[index])
				} else {
					adds = append(adds, ops[index])
				}
				index++
			}
			for row := 0; row < max(len(dels), len(adds)); row++ {
				var left, right *diffOp
				if row < len(dels) {
					left = &dels[row]
				}
				if row < len(adds) {
					right = &adds[row]
				}
				leftClass, rightClass := "pm-code pm-empty", "pm-code pm-empty"
				var leftLine, rightLine *hNode
				var leftText, rightText *hNode
				lb, ra := 0, 0
				if left != nil {
					leftClass, leftLine, leftText, lb = "pm-code pm-del", lineNumber(left.before), txt(left.text), left.before
				}
				if right != nil {
					rightClass, rightLine, rightText, ra = "pm-code pm-add", lineNumber(right.after), txt(right.text), right.after
				}
				rows = append(rows, el("tr", nil, td("pm-ln", leftLine), td(leftClass, leftText), td("pm-ln", rightLine), td(rightClass, rightText)))
				rows = append(rows, noteRow(append(notesFor(notes, "before", lb), notesFor(notes, "after", ra)...), 4))
			}
		}
	} else {
		for _, op := range ops {
			marker := " "
			switch op.kind {
			case "add":
				marker = "+"
			case "del":
				marker = "-"
			}
			rows = append(rows, el("tr", nil, td("pm-ln", lineNumber(op.before)), td("pm-ln", lineNumber(op.after)), td("pm-code pm-"+op.kind, txt(marker), txt(" "), txt(op.text))))
			var here []annotation
			if op.kind == "del" {
				here = notesFor(notes, "before", op.before)
			} else {
				here = notesFor(notes, "after", op.after)
			}
			rows = append(rows, noteRow(here, 3))
		}
	}
	head := codeHead(props)
	head.children = append(head.children, el("span", attrs("class", "pm-stats"),
		el("span", attrs("class", "pm-plus"), txt("+"), txt(itoa(added))), txt(" "),
		el("span", attrs("class", "pm-minus"), txt("−"), txt(itoa(removed)))))
	tableClass := "pm-diff-table pm-unified"
	if split {
		tableClass = "pm-diff-table pm-split"
	}
	return el("figure", attrs("class", "pm-block pm-code-block pm-diff"), head, summaryLine(props),
		el("div", attrs("class", "pm-scroll"), el("table", attrs("class", tableClass), el("tbody", nil, rows...))))
}

func renderAnnotatedCode(props *object) *hNode {
	notes := annotations(props.field("annotations"))
	var rows []*hNode
	for index, line := range splitLines(props.field("code")) {
		here := notesFor(notes, "after", index+1)
		var a []hAttr
		if len(here) > 0 {
			a = attrs("class", "pm-noted")
		}
		rows = append(rows, el("tr", a, el("td", attrs("class", "pm-ln"), txt(itoa(index+1))), el("td", attrs("class", "pm-code"), txt(line))))
		rows = append(rows, noteRow(here, 2))
	}
	return el("figure", attrs("class", "pm-block pm-code-block pm-annotated"), codeHead(props), summaryLine(props),
		el("div", attrs("class", "pm-scroll"), el("table", attrs("class", "pm-diff-table"), el("tbody", nil, rows...))))
}

// ---------- structure blocks ----------

type treeDir struct {
	name  string
	order []string
	dirs  map[string]*treeDir
	files []*object
}

func newTreeDir(name string) *treeDir { return &treeDir{name: name, dirs: map[string]*treeDir{}} }

func buildTree(files []*object) *treeDir {
	root := newTreeDir("")
	for _, file := range files {
		var parts []string
		for _, p := range strings.Split(text(file.field("path")), "/") {
			if p != "" {
				parts = append(parts, p)
			}
		}
		current := root
		for i := 0; i+1 < len(parts); i++ {
			part := parts[i]
			if _, ok := current.dirs[part]; !ok {
				current.dirs[part] = newTreeDir(part)
				current.order = append(current.order, part)
			}
			current = current.dirs[part]
		}
		copied := newObject()
		for _, k := range file.keys {
			copied.set(k, file.values[k])
		}
		name := text(file.field("path"))
		if len(parts) > 0 {
			name = parts[len(parts)-1]
		}
		copied.set("name", name)
		current.files = append(current.files, copied)
	}
	return root
}

var collator = collate.New(language.English)

func treeNodes(dir *treeDir) *hNode {
	dirs := make([]*treeDir, 0, len(dir.order))
	for _, name := range dir.order {
		dirs = append(dirs, dir.dirs[name])
	}
	sort.SliceStable(dirs, func(i, j int) bool { return collator.CompareString(dirs[i].name, dirs[j].name) < 0 })
	list := el("ul", nil)
	for _, child := range dirs {
		node, label := child, child.name
		for len(node.files) == 0 && len(node.order) == 1 {
			node = node.dirs[node.order[0]]
			label += "/" + node.name
		}
		list.children = append(list.children, el("li", attrs("class", "pm-tree-dir"), el("span", attrs("class", "pm-tree-name"), txt(label), txt("/")), treeNodes(node)))
	}
	for _, file := range dir.files {
		item := el("li", attrs("class", "pm-tree-file"), el("span", attrs("class", "pm-tree-name"), txt(text(file.field("name")))), changeBadge(file.field("change")))
		additions, deletions := file.field("additions"), file.field("deletions")
		if isFinite(additions) || isFinite(deletions) {
			stats := el("span", attrs("class", "pm-stats"))
			if isFinite(additions) {
				stats.children = append(stats.children, el("span", attrs("class", "pm-plus"), txt("+"), txt(text(additions))))
			}
			stats.children = append(stats.children, txt(" "))
			if isFinite(deletions) {
				stats.children = append(stats.children, el("span", attrs("class", "pm-minus"), txt("−"), txt(text(deletions))))
			}
			item.children = append(item.children, stats)
		}
		if truthy(file.field("note")) {
			item.children = append(item.children, el("span", attrs("class", "pm-tree-note"), txt(text(file.field("note")))))
		}
		list.children = append(list.children, item)
	}
	return list
}

func records(v value) []*object {
	var out []*object
	for _, item := range asArray(v) {
		out = append(out, asRecord(item))
	}
	return out
}

func renderFileTree(props *object) *hNode {
	files := records(props.field("files"))
	sum := func(key string) float64 {
		total := 0.0
		for _, f := range files {
			if v := f.field(key); isFinite(v) {
				total += v.(float64)
			}
		}
		return total
	}
	plural := "s"
	if len(files) == 1 {
		plural = ""
	}
	return el("section", attrs("class", "pm-block pm-tree"),
		el("header", attrs("class", "pm-block-head"),
			el("h4", attrs("class", "pm-block-title"), txt(text(nullish(props.field("title"), "Changed files")))),
			el("p", attrs("class", "pm-block-summary"), txt(itoa(len(files))), txt(" file"), txt(plural), txt(" · "),
				el("span", attrs("class", "pm-plus"), txt("+"), txt(numberString(sum("additions")))), txt(" "),
				el("span", attrs("class", "pm-minus"), txt("−"), txt(numberString(sum("deletions")))))),
		treeNodes(buildTree(files)))
}

func wasType(was, typ value) []*hNode {
	var out []*hNode
	if truthy(was) {
		out = append(out, fragment(el("del", nil, txt(text(was))), txt(" → ")))
	}
	return append(out, el("code", nil, txt(text(typ))))
}

func renderDataModel(props *object) *hNode {
	relations := records(props.field("relations"))
	grid := el("div", attrs("class", "pm-model-grid"))
	for _, entity := range records(props.field("entities")) {
		class := "pm-entity"
		if isChange(entity.field("change")) {
			class += " pm-entity-" + entity.field("change").(string)
		}
		article := el("article", attrs("class", class), el("header", nil, el("strong", nil, txt(text(entity.field("name")))), changeBadge(entity.field("change"))))
		if truthy(entity.field("note")) {
			article.children = append(article.children, el("p", attrs("class", "pm-entity-note"), txt(text(entity.field("note")))))
		}
		body := el("tbody", nil)
		for _, field := range records(entity.field("fields")) {
			var a []hAttr
			if isChange(field.field("change")) {
				a = attrs("class", "pm-field-"+field.field("change").(string))
			}
			name := el("td", attrs("class", "pm-field-name"))
			if truthy(field.field("key")) {
				name.children = append(name.children, el("span", attrs("class", "pm-key"), txt(text(field.field("key")))))
			}
			name.children = append(name.children, txt(text(field.field("name"))))
			notes := el("td", nil, changeBadge(field.field("change")))
			if truthy(field.field("note")) {
				notes.children = append(notes.children, el("span", attrs("class", "pm-field-note"), txt(text(field.field("note")))))
			}
			body.children = append(body.children, el("tr", a, name, el("td", attrs("class", "pm-field-type"), wasType(field.field("was"), field.field("type"))...), notes))
		}
		article.children = append(article.children, el("table", nil, body))
		grid.children = append(grid.children, article)
	}
	section := el("section", attrs("class", "pm-block pm-model"), blockTitle(props.field("title"), nil), grid)
	if len(relations) > 0 {
		list := el("ul", attrs("class", "pm-relations"))
		for _, r := range relations {
			item := el("li", nil, el("code", nil, txt(text(r.field("from")))), txt(" → "), el("code", nil, txt(text(r.field("to")))))
			if truthy(r.field("label")) {
				item.children = append(item.children, txt(" "+text(r.field("label"))))
			}
			list.children = append(list.children, item)
		}
		section.children = append(section.children, list)
	}
	return section
}

func renderEndpoint(props *object, children []*hNode) *hNode {
	params := records(props.field("params"))
	request := asRecord(props.field("request"))
	method := text(props.field("method"))
	class := "pm-block pm-endpoint"
	if truthy(props.field("deprecated")) {
		class += " pm-deprecated"
	}
	head := el("header", attrs("class", "pm-endpoint-head"),
		el("span", attrs("class", "pm-method pm-method-"+strings.ToLower(method)), txt(method)),
		el("code", attrs("class", "pm-path"), txt(text(props.field("path")))),
		changeBadge(props.field("change")))
	if truthy(props.field("deprecated")) {
		head.children = append(head.children, el("span", attrs("class", "pm-change pm-change-removed"), txt("deprecated")))
	}
	section := el("section", attrs("class", class), head)
	if len(children) > 0 {
		section.children = append(section.children, el("div", attrs("class", "pm-endpoint-body"), children...))
	}
	if len(params) > 0 {
		body := el("tbody", nil)
		for _, p := range params {
			name := el("td", nil, el("code", nil, txt(text(p.field("name")))))
			if truthy(p.field("required")) {
				name.children = append(name.children, el("span", attrs("class", "pm-required"), txt("required")))
			}
			body.children = append(body.children, el("tr", nil, name,
				el("td", nil, txt(text(p.field("in")))),
				el("td", nil, wasType(p.field("was"), p.field("type"))...),
				el("td", nil, changeBadge(p.field("change")), txt(text(p.field("note"))))))
		}
		head := el("thead", nil, el("tr", nil, el("th", nil, txt("Param")), el("th", nil, txt("In")), el("th", nil, txt("Type")), el("th", nil, txt("Notes"))))
		section.children = append(section.children, el("table", attrs("class", "pm-params"), head, body))
	}
	if request.field("example") != undefined {
		label := el("span", attrs("class", "pm-example-label"), txt("Request"))
		if truthy(request.field("contentType")) {
			label.children = append(label.children, txt(" · "+text(request.field("contentType"))))
		}
		section.children = append(section.children, el("div", attrs("class", "pm-example"), label, el("pre", nil, el("code", nil, txt(prettyJSON(request.field("example")))))))
	}
	for _, r := range records(props.field("responses")) {
		status := text(r.field("status"))
		first := ""
		for _, c := range status {
			first = string(c)
			break
		}
		label := el("span", attrs("class", "pm-example-label"),
			el("span", attrs("class", "pm-status pm-status-"+first+"xx"), txt(status)), txt(" "),
			txt(text(r.field("description"))), txt(" "), changeBadge(r.field("change")))
		example := el("div", attrs("class", "pm-example"), label)
		if r.field("example") != undefined {
			example.children = append(example.children, el("pre", nil, el("code", nil, txt(prettyJSON(r.field("example"))))))
		}
		section.children = append(section.children, example)
	}
	return section
}

func renderFlow(props *object) *hNode {
	direction := "horizontal"
	if props.field("direction") == "vertical" {
		direction = "vertical"
	}
	list := el("ol", attrs("class", "pm-flow pm-flow-"+direction))
	for _, step := range records(props.field("steps")) {
		item := el("li", attrs("class", "pm-flow-step"), el("span", attrs("class", "pm-flow-label"), el("strong", nil, txt(text(step.field("label")))), changeBadge(step.field("change"))))
		if truthy(step.field("detail")) {
			item.children = append(item.children, el("span", nil, txt(text(step.field("detail")))))
		}
		list.children = append(list.children, item)
	}
	return el("section", attrs("class", "pm-block pm-flow-block"), blockTitle(props.field("title"), nil), list)
}

func renderLayers(props *object) *hNode {
	section := el("section", attrs("class", "pm-block pm-layers"), blockTitle(props.field("title"), nil))
	for _, layer := range records(props.field("layers")) {
		label := el("div", attrs("class", "pm-layer-label"), el("strong", nil, txt(text(layer.field("label")))))
		if truthy(layer.field("note")) {
			label.children = append(label.children, el("span", nil, txt(text(layer.field("note")))))
		}
		items := el("ul", attrs("class", "pm-layer-items"))
		for _, item := range asArray(layer.field("items")) {
			v := asRecord(item)
			if s, ok := item.(string); ok {
				v = newObject()
				v.set("label", s)
			}
			var a []hAttr
			if isChange(v.field("change")) {
				a = append(a, hAttr{"class", "pm-item-" + v.field("change").(string)})
			}
			if truthy(v.field("note")) {
				a = append(a, hAttr{"title", text(v.field("note"))})
			}
			items.children = append(items.children, el("li", a, txt(text(v.field("label"))), changeBadge(v.field("change"))))
		}
		section.children = append(section.children, el("div", attrs("class", "pm-layer"), label, items))
	}
	return section
}

func renderQuestions(props *object) *hNode {
	list := el("ol", nil)
	for _, item := range records(props.field("items")) {
		li := el("li", nil, el("p", attrs("class", "pm-question"), txt(text(item.field("question")))))
		if truthy(item.field("recommendation")) {
			li.children = append(li.children, el("p", attrs("class", "pm-recommendation"), el("span", nil, txt("Recommended")), txt(" "), txt(text(item.field("recommendation")))))
		}
		if options := asArray(item.field("options")); len(options) > 0 {
			ul := el("ul", attrs("class", "pm-options"))
			for _, o := range options {
				ul.children = append(ul.children, el("li", nil, txt(text(o))))
			}
			li.children = append(li.children, ul)
		}
		list.children = append(list.children, li)
	}
	return el("section", attrs("class", "pm-block pm-questions"), blockTitle(nullish(props.field("title"), "Open questions"), nil), list)
}

func renderTabs(r *blockRecord, children []*hNode) *hNode {
	var panels []*hNode
	for _, c := range children {
		if !c.isText {
			panels = append(panels, c)
		}
	}
	group := "pm-tabs-" + itoa(r.index)
	section := el("section", attrs("class", "pm-block pm-tabs"), blockTitle(r.props.field("title"), nil))
	for index := range r.tabs {
		a := attrs("class", "pm-tab-input", "type", "radio", "id", group+"-"+itoa(index), "name", group)
		if index == 0 {
			a = append(a, hAttr{"checked", ""})
		}
		section.children = append(section.children, el("input", a))
	}
	list := el("div", attrs("class", "pm-tab-list"))
	for index, label := range r.tabs {
		list.children = append(list.children, el("label", attrs("for", group+"-"+itoa(index)), txt(label)))
	}
	section.children = append(section.children, list, el("div", attrs("class", "pm-tab-panels"), panels...))
	return section
}

func renderBlock(r *blockRecord, children []*hNode) *hNode {
	if r.err != "" {
		return blockError(r.err, r.inline)
	}
	props := r.props
	switch r.name {
	case "Callout":
		tone := "note"
		if s, ok := props.field("tone").(string); ok {
			tone = s
		}
		return el("aside", attrs("class", "pm-block pm-callout pm-tone-"+tone), append([]*hNode{el("p", attrs("class", "pm-callout-title"), txt(text(nullish(props.field("title"), tone))))}, children...)...)
	case "Columns":
		return el("section", attrs("class", "pm-block pm-columns-block"), blockTitle(props.field("title"), nil), el("div", attrs("class", "pm-columns"), children...))
	case "Column":
		column := el("div", attrs("class", "pm-column"))
		if truthy(props.field("label")) {
			column.children = append(column.children, el("p", attrs("class", "pm-column-label"), txt(text(props.field("label")))))
		}
		column.children = append(column.children, children...)
		return column
	case "Tabs":
		return renderTabs(r, children)
	case "Tab":
		return el("div", attrs("class", "pm-tab-panel"), children...)
	case "FileTree":
		return renderFileTree(props)
	case "Diff":
		return renderDiff(props)
	case "AnnotatedCode":
		return renderAnnotatedCode(props)
	case "DataModel":
		return renderDataModel(props)
	case "Endpoint":
		return renderEndpoint(props, children)
	case "Flow":
		return renderFlow(props)
	case "Layers":
		return renderLayers(props)
	case "Questions":
		return renderQuestions(props)
	}
	return blockError(unknownBlockMessage(r.name), r.inline)
}

// ---------- serialization ----------

var voidElements = setOf("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr")

var tableElements = setOf("table", "tbody", "thead", "tfoot", "tr")

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;")

type serializer struct {
	b        strings.Builder
	problems []string
}

func (s *serializer) write(n *hNode, parent string) {
	if n == nil {
		return
	}
	switch {
	case n.isText:
		if tableElements[parent] && strings.TrimSpace(n.text) == "" {
			return
		}
		s.b.WriteString(htmlEscaper.Replace(n.text))
	case n.record != nil:
		if n.record.err != "" {
			s.problems = append(s.problems, n.record.err)
		}
		s.write(renderBlock(n.record, n.children), parent)
	case n.tag == "":
		for _, c := range n.children {
			s.write(c, parent)
		}
	default:
		s.b.WriteString("<" + n.tag)
		for _, a := range n.attrs {
			s.b.WriteString(" " + a.name + `="` + htmlEscaper.Replace(a.value) + `"`)
		}
		if voidElements[n.tag] {
			s.b.WriteString("/>")
			return
		}
		s.b.WriteString(">")
		for _, c := range n.children {
			s.write(c, n.tag)
		}
		s.b.WriteString("</" + n.tag + ">")
	}
}

// render is PlanMdx: it renders source to HTML and collects block problems.
func render(source string) (string, []string) {
	parsed := parseMdx(source)
	s := &serializer{}
	if parsed.parseError != "" {
		message := "MDX could not be parsed: " + parsed.parseError
		s.problems = append(s.problems, message)
		s.write(blockError(message, false), "")
		s.write(el("pre", attrs("class", "markdown-fallback"), txt(source)), "")
		return s.b.String(), s.problems
	}
	h := &toHast{footnotes: parsed.footnotes, footnoteCounts: map[string]int{}}
	nodes := h.one(parsed.root, nil)
	if foot := h.footer(); foot != nil {
		nodes = append(nodes, txt("\n"), foot)
	}
	for _, n := range nodes {
		s.write(n, "")
	}
	return s.b.String(), s.problems
}
