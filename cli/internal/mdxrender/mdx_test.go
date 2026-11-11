package mdxrender

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Ports of test/lib/mdx.test.js, plus security checks on the output.

func wrapped(b BlockSpec) string {
	if b.Parent != "" {
		return "<" + b.Parent + ">\n" + strings.Replace(b.Example, "...", "Body", 1) + "\n</" + b.Parent + ">"
	}
	return b.Example
}

func TestCatalogExamplesRenderWithoutErrors(t *testing.T) {
	for _, b := range Blocks {
		html := RenderHTML(wrapped(b))
		if strings.Contains(html, "pm-block-error") {
			t.Errorf("%s: %s", b.Name, html)
		}
		if !regexp.MustCompile(`pm-block|pm-column|pm-tab-panel`).MatchString(html) {
			t.Errorf("%s rendered no block: %s", b.Name, html)
		}
		if !strings.Contains(BlocksReference(), "## <"+b.Name+">") {
			t.Errorf("reference lacks %s", b.Name)
		}
	}
}

func TestParsedNeverEvaluated(t *testing.T) {
	html := RenderHTML(strings.Join([]string{
		`import fs from "node:fs"`,
		`export const x = 1`,
		`{globalThis.process.exit(1)}`,
		`<Evil onClick={alert(1)} />`,
		`<Diff filename="a" before={secret} after="b" />`,
		"<Callout title={`hi ${name}`}>x</Callout>",
		`<FileTree files={[{ path: "a", __proto__: { polluted: true } }]} />`,
		"<Callout {...props}>\nspread\n</Callout>",
		`<script>alert(1)</script>`,
		`<a href="javascript:alert(1)">x</a>`,
		`[bad](javascript:alert(1))`,
	}, "\n\n"))
	if regexp.MustCompile(`(?i)<script|javascript:|onclick`).MatchString(html) {
		t.Fatalf("active content survived: %s", html)
	}
	for _, want := range []string{
		"import and export statements are not supported",
		`{expressions} are not supported`,
		"Unknown block &lt;Evil&gt;",
		"variables are not supported",
		"object key &quot;__proto__&quot; is not allowed",
		"spread attributes are not supported",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in %s", want, html)
		}
	}
}

func TestValidationMessages(t *testing.T) {
	html := RenderHTML(strings.Join([]string{
		`<Diff filename="a.ts" />`,
		`<FileTree files="nope" />`,
		"<Callout tone=\"loud\">\nx\n</Callout>",
		"<Tab label=\"orphan\">\nx\n</Tab>",
		"<Tabs>\nloose text\n</Tabs>",
		`<ApiEndpoint method="GET" path="/" />`,
	}, "\n\n"))
	for _, want := range []string{
		"missing required prop &quot;before&quot;",
		"prop &quot;files&quot; must be array, got string",
		"prop &quot;tone&quot; must be one of",
		"&lt;Tab&gt; is only valid inside &lt;Tabs&gt;",
		"&lt;Tabs&gt; may only contain &lt;Tab&gt; elements",
		"did you mean &lt;Endpoint&gt;",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in %s", want, html)
		}
	}
}

func TestUnparseableFallsBackToEscapedSource(t *testing.T) {
	html := RenderHTML("<Callout>\nnever closed <b>")
	if !strings.Contains(html, "MDX could not be parsed") || !strings.Contains(html, `<pre class="markdown-fallback">&lt;Callout&gt;`) {
		t.Fatal(html)
	}
}

func TestTaskCheckboxesKeepToggleContract(t *testing.T) {
	html := RenderHTML("<Callout>\n- [ ] inside\n</Callout>\n\n- [x] outside")
	if n := strings.Count(html, `data-plan-task="true"`); n != 2 {
		t.Fatalf("%d task inputs: %s", n, html)
	}
	if !strings.Contains(html, `data-plan-task="true" checked=""`) {
		t.Fatal(html)
	}
}

func TestTabsRenderRadios(t *testing.T) {
	html := RenderHTML("<Tabs>\n<Tab label=\"one.ts\">\nFirst\n</Tab>\n<Tab label=\"two.ts\">\nSecond\n</Tab>\n</Tabs>")
	if strings.Count(html, `type="radio"`) != 2 ||
		!strings.Contains(html, `<label for="pm-tabs-0-0">one.ts</label><label for="pm-tabs-0-1">two.ts</label>`) ||
		!strings.Contains(html, `id="pm-tabs-0-0" name="pm-tabs-0" checked=""`) {
		t.Fatal(html)
	}
}

func TestDiffLines(t *testing.T) {
	ops := diffLines([]string{"a", "b", "c", "d"}, []string{"a", "x", "c", "d", "e"})
	var got []string
	for _, op := range ops {
		got = append(got, op.kind+":"+op.text)
	}
	if strings.Join(got, " ") != "same:a del:b add:x same:c same:d add:e" {
		t.Fatal(got)
	}
	if last := ops[len(ops)-1]; last.before != 0 || last.after != 5 {
		t.Fatal(last)
	}
	html := RenderHTML(`<Diff filename="x.ts" mode="unified" before={"a\nb"} after={"a\nc"} annotations={[{ line: 2, note: "Renamed" }]} />`)
	for _, want := range []string{`pm-del">- b`, `pm-add">+ c`, "<p>Renamed</p>"} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q: %s", want, html)
		}
	}
}

func TestFormatDetection(t *testing.T) {
	cases := map[string]string{
		"---\nid: a\nformat: mdx\n---\n# x": "mdx",
		"---\nformat: 'mdx'\n---\n":         "mdx",
		"# format: mdx":                     "md",
	}
	for source, want := range cases {
		if got := SourceFormat(source); got != want {
			t.Errorf("SourceFormat(%q) = %s", source, got)
		}
	}
	if got := StripFrontmatter("---\nformat: mdx\n---\n<Callout />"); got != "<Callout />" {
		t.Error(got)
	}
}

func TestCheckedInDocsPass(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/recaps/mdx-visual-plans.mdx")
	if err != nil {
		t.Skip("docs not present")
	}
	if SourceFormat(string(raw)) != "mdx" {
		t.Fatal("doc must declare format: mdx")
	}
	if problems := Check(StripFrontmatter(string(raw))); len(problems) != 0 {
		t.Fatal(problems)
	}
}

// Raw HTML, unsafe URLs, and remote images must never reach the output,
// whatever the input.
func TestOutputIsInert(t *testing.T) {
	inputs := []string{
		`<script>alert(1)</script>`,
		"<script>\nalert(1)\n</script>",
		`<img src="https://evil.example/x.png" onerror="alert(1)" />`,
		`<iframe src="https://evil.example"></iframe>`,
		`<div onclick="alert(1)" style="x">hi</div>`,
		`<b onmouseover="alert(1)">x</b>`,
		`<a href="javascript:alert(1)">x</a>`,
		`[x](javascript:alert(1)) [y](JAVASCRIPT:alert(1)) [z](vbscript:x) [d](data:text/html,<script>)`,
		`![remote](https://evil.example/track.png) ![rel](/local.png)`,
		`[![img](https://evil.example/i.png)](https://ok.example)`,
		"<Callout title=\"<script>alert(1)</script>\">\nx\n</Callout>",
		`<Flow steps={[{ label: "<img src=x onerror=alert(1)>" }]} />`,
		`<Endpoint method="GET" path="/" responses={[{ status: 200, example: "<script>alert(1)</script>" }]} />`,
		"<Callout>\n<style>\n{\"body{}\"}\n</style>\n</Callout>",
		"```html\n<script>alert(1)</script>\n```",
		`<!-- <script>alert(1)</script> -->`,
		`<form action="https://evil.example"><button>x</button></form>`,
		`<input type="checkbox" checked>`,
		`<svg onload="alert(1)"></svg>`,
		`www.example.com/<script>`,
	}
	tag := regexp.MustCompile(`<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>`)
	allowedTags := setOf("a", "abbr", "article", "aside", "b", "blockquote", "br", "code", "del", "details", "div", "em", "figcaption", "figure",
		"h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "input", "kbd", "label", "li", "mark", "ol", "p", "pre", "s", "section", "small", "span",
		"strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul")
	for _, input := range inputs {
		html := RenderHTML(input)
		for _, m := range tag.FindAllStringSubmatch(html, -1) {
			if !allowedTags[strings.ToLower(m[1])] {
				t.Errorf("%q produced <%s>: %s", input, m[1], html)
			}
			if regexp.MustCompile(`(?i)\son\w+=|\ssrc=|\sstyle="(?:[^t]|t[^e])`).MatchString(m[2]) {
				t.Errorf("%q produced an active attribute in %s", input, m[0])
			}
			if m[1] == "input" && !strings.Contains(m[2], `disabled=""`) {
				t.Errorf("%q produced an enabled input: %s", input, m[0])
			}
		}
		if regexp.MustCompile(`(?i)href="\s*(javascript|vbscript|data):`).MatchString(html) {
			t.Errorf("%q produced an unsafe link: %s", input, html)
		}
	}
}
