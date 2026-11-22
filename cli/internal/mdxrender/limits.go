package mdxrender

import "fmt"

// Limits that keep rendering one plan bounded in time and memory. Plans are
// read on every dashboard page load, so a crafted plan must not be able to
// stall or exhaust `plan serve`.
const (
	// maxParseWork bounds the bytes handed to the JavaScript parser per
	// render. Expressions are retried at each `}` the way micromark does;
	// the scanner skips braces that cannot close, and this is the backstop
	// for inputs that still retry a lot.
	maxParseWork = 16 << 20
	// maxNesting bounds element, list, and quote nesting.
	maxNesting = 128
	// maxTableColumns and maxTableCells bound a GFM table, whose rows are
	// padded to the header's width.
	maxTableColumns = 128
	maxTableCells   = 100_000
	// maxHTMLBytes bounds the rendered HTML.
	maxHTMLBytes = 8 << 20
	// maxBracketNesting bounds `[` nesting. goldmark's link parser checks
	// each link's text for nested links, which is quadratic in the nesting.
	maxBracketNesting = 1000
)

// bracketDepth is the deepest `[` nesting in source, counting brackets in
// code too; real plans stay far below maxBracketNesting.
func bracketDepth(source string) int {
	depth, deepest := 0, 0
	for i := 0; i < len(source); i++ {
		switch source[i] {
		case '[':
			depth++
			deepest = max(deepest, depth)
		case ']':
			depth = max(depth-1, 0)
		}
	}
	return deepest
}

var errTooComplex = &syntaxError{msg: "Plan is too complex to parse as MDX"}

// workBudget counts down parser work for one render. A nil budget is
// unlimited.
type workBudget struct{ left int }

func newWorkBudget() *workBudget { return &workBudget{left: maxParseWork} }

// spend charges n bytes and reports whether the budget still holds.
func (b *workBudget) spend(n int) bool {
	if b == nil {
		return true
	}
	b.left -= n
	return b.left >= 0
}

func (b *workBudget) exhausted() bool { return b != nil && b.left < 0 }

func nestingError() string {
	return fmt.Sprintf("Plan nests elements, lists, or quotes more than %d levels deep", maxNesting)
}
