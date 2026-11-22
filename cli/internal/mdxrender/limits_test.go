package mdxrender

import (
	"strings"
	"testing"
	"time"
)

// Deep nesting used to overflow the recursive-descent parsers' stacks, a
// fatal error recover() cannot catch. Each case must render an error card.
func TestDeepExpressionNestingRendersErrorCard(t *testing.T) {
	const n = 1_000_000
	cases := map[string]string{
		"array": "<Flow steps={" + strings.Repeat("[", n) + strings.Repeat("]", n) + "} />",
		"paren": "Text {" + strings.Repeat("(", n) + "1" + strings.Repeat(")", n) + "}",
		"unary": "<Flow steps={" + strings.Repeat("!", n) + "[]} />",
		"new":   "<Flow steps={" + strings.Repeat("new ", n/4) + "X} />",
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			html, problems := render(src)
			if !strings.Contains(html, "pm-block-error") || len(problems) == 0 {
				t.Fatalf("no error card: %.200s", html)
			}
		})
	}
}

// Deep example JSON is shown as written: parsing it recursed without bound,
// and pretty-printing it costs quadratic output in its depth.
func TestDeepExampleJSONFallsBackToText(t *testing.T) {
	const n = 1000
	example := strings.Repeat(`{"a":`, n) + "1" + strings.Repeat("}", n)
	src := "<Endpoint method=\"GET\" path=\"/x\" responses={[{ status: 200, example: '" + example + "' }]}>\nBody\n</Endpoint>"
	html := RenderHTML(src)
	if !strings.Contains(html, "<pre><code>"+strings.Repeat("{&quot;a&quot;:", 50)) {
		t.Fatalf("example not shown as written: %.300s", html)
	}
}

// Nesting a real plan would use still parses.
func TestModerateNestingStillParses(t *testing.T) {
	src := strings.Repeat("[", 50) + strings.Repeat("]", 50)
	if _, _, err := parseExpressionAt(src); err != nil {
		t.Fatalf("50 nested arrays rejected: %s", err.msg)
	}
	if _, _, err := parseExpressionAt("[" + src + "]"); err != nil {
		t.Fatalf("51 nested arrays rejected: %s", err.msg)
	}
	if _, _, err := parseExpressionAt(strings.Repeat("[", 1000) + strings.Repeat("]", 1000)); err == nil {
		t.Fatal("1000 nested arrays accepted")
	}
}

func nestedList(levels int) string {
	var b strings.Builder
	for i := 0; i < levels; i++ {
		b.WriteString(strings.Repeat("  ", i) + "- x\n")
	}
	return b.String()
}

// Inputs whose render cost was super-linear. Each must render quickly, and
// either render or return a bounded error card.
func TestPathologicalInputsRenderQuickly(t *testing.T) {
	wideHeader := "|" + strings.Repeat(" a |", 8000) + "\n|" + strings.Repeat("-|", 8000) + "\n"
	cases := []struct {
		name, src string
		wantError bool
	}{
		{"nested objects", "<Flow steps={" + strings.Repeat("{a:", 2000) + "1" + strings.Repeat("}", 2000) + "} />", true},
		{"deep objects", "<Flow steps={" + strings.Repeat("{a:", 200_000) + "1" + strings.Repeat("}", 200_000) + "} />", true},
		{"large valid prop", "<Flow steps={[" + strings.Repeat(`{label:"a"},`, 20_000) + "]} />", false},
		{"large invalid prop", "<Flow steps={[" + strings.Repeat(`{label:"a"},`, 20_000) + "} />", true},
		{"large code prop", `<Diff filename="a.go" before={"` + strings.Repeat(`func f() { if x { y() } }\n`, 20_000) + `"} after={"b"} />`, false},
		{"nested html tags", strings.Repeat("<div>", 8000) + strings.Repeat("</div>", 8000), true},
		{"nested callouts", strings.Repeat("<Callout>\n", 8000) + strings.Repeat("</Callout>\n", 8000), true},
		{"inline callouts", strings.Repeat("<Callout>", 8000) + strings.Repeat("</Callout>", 8000), true},
		{"unclosed callouts", strings.Repeat("<Callout>\n", 8000), true},
		{"sibling callouts", strings.Repeat("<Callout>\nx\n</Callout>\n", 20_000), false},
		{"nested lists", nestedList(500), true},
		{"nested quotes", strings.Repeat(">", 2000) + " x\n", true},
		{"wide table", wideHeader + "|" + strings.Repeat(" b |", 8000) + "\n", true},
		{"padded table rows", wideHeader + strings.Repeat("|\n", 4000), true},
		{"nested brackets", strings.Repeat("[", 1_000_000) + strings.Repeat("]", 1_000_000), true},
		{"open braces", strings.Repeat("{a", 200_000), true},
		{"open tags", strings.Repeat("<a", 200_000), true},
		{"brackets", strings.Repeat("[a", 200_000), true},
		{"bracket pairs", strings.Repeat("[a] ", 200_000), false},
		{"parens", "Text " + strings.Repeat("(", 500_000), false},
		{"many tasks", strings.Repeat("- [ ] x\n", 250_000), true},
		{"long list", strings.Repeat("- x\n", 50_000), false},
		{"table at the limit", "|" + strings.Repeat(" a |", 128) + "\n|" + strings.Repeat("-|", 128) + "\n" + strings.Repeat("|"+strings.Repeat(" b |", 128)+"\n", 700), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			start := time.Now()
			html, problems := render(c.src)
			if took := time.Since(start); took > time.Second {
				t.Errorf("took %v", took)
			}
			if got := strings.Contains(html, "pm-block-error"); got != c.wantError {
				t.Errorf("error card = %v, want %v (problems %q)", got, c.wantError, problems)
			}
			if limit := maxHTMLBytes + 6*len(c.src) + 4096; len(html) > limit {
				t.Errorf("output %d bytes exceeds %d", len(html), limit)
			}
		})
	}
}
