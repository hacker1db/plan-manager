package mdx

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func wrapped(b Block) string {
	if b.Parent == "" {
		return b.Example
	}
	return "<" + b.Parent + ">\n" + strings.Replace(b.Example, "...", "Body", 1) + "\n</" + b.Parent + ">"
}

func TestCatalogExamplesPassCheck(t *testing.T) {
	if len(Blocks) == 0 {
		t.Fatal("empty block registry")
	}
	for _, b := range Blocks {
		if problems := Check(wrapped(b)); len(problems) > 0 {
			t.Errorf("%s example: %v", b.Name, problems)
		}
	}
}

func TestReferenceMatchesGolden(t *testing.T) {
	want, err := os.ReadFile("testdata/blocks-reference.md")
	if err != nil {
		t.Fatal(err)
	}
	if got := Reference(); got != string(want) {
		t.Errorf("Reference() drifted from testdata/blocks-reference.md")
	}
	for _, b := range Blocks {
		if !strings.Contains(Reference(), "## <"+b.Name+">") {
			t.Errorf("reference is missing %s", b.Name)
		}
	}
}

func TestCatalogJSONIsVersioned(t *testing.T) {
	var doc struct {
		Version int `json:"version"`
		Blocks  []struct {
			Name string `json:"name"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(CatalogJSON(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Version != 1 || len(doc.Blocks) != len(Blocks) {
		t.Fatalf("version %d, %d blocks", doc.Version, len(doc.Blocks))
	}
}

func contains(problems []string, substr string) bool {
	for _, p := range problems {
		if strings.Contains(p, substr) {
			return true
		}
	}
	return false
}

func TestImportsExpressionsAndUnknownTagsAreProblems(t *testing.T) {
	problems := Check(strings.Join([]string{
		`import fs from "node:fs"`,
		`export const x = 1`,
		`{globalThis.process.exit(1)}`,
		`<Evil onClick={alert(1)} />`,
		`<Diff filename="a" before={secret} after="b" />`,
		"<Callout title={`hi ${name}`}>x</Callout>",
		`<FileTree files={[{ path: "a", __proto__: { polluted: true } }]} />`,
		"<Callout {...props}>\nspread\n</Callout>",
	}, "\n\n"))
	for _, want := range []string{
		"import and export statements are not supported",
		"{expressions} are not supported",
		"Unknown block <Evil>",
		"variables are not supported",
		`object key "__proto__" is not allowed`,
		"spread attributes are not supported",
	} {
		if !contains(problems, want) {
			t.Errorf("missing %q in %v", want, problems)
		}
	}
}

func TestValidationNamesPropAndPlacementProblems(t *testing.T) {
	problems := Check(strings.Join([]string{
		`<Diff filename="a.ts" />`,
		`<FileTree files="nope" />`,
		"<Callout tone=\"loud\">\nx\n</Callout>",
		"<Tab label=\"orphan\">\nx\n</Tab>",
		"<Tabs>\nloose text\n</Tabs>",
		`<ApiEndpoint method="GET" path="/" />`,
	}, "\n\n"))
	for _, want := range []string{
		`missing required prop "before"`,
		`prop "files" must be array, got string`,
		`prop "tone" must be one of`,
		"<Tab> is only valid inside <Tabs>",
		"<Tabs> may only contain <Tab> elements",
		"did you mean <Endpoint>",
	} {
		if !contains(problems, want) {
			t.Errorf("missing %q in %v", want, problems)
		}
	}
}

func TestUnparseableMDXIsOneProblem(t *testing.T) {
	problems := Check("<Callout>\nnever closed <b>")
	if len(problems) != 1 || !strings.HasPrefix(problems[0], "MDX could not be parsed") {
		t.Fatalf("got %v", problems)
	}
}

// check-cases.json holds documents with the problems the TypeScript renderer
// (remark-mdx) reported for them when this checker was written. Parse error
// wording differs, so only the fact of a parse error is compared.
func TestCheckMatchesRemarkMdx(t *testing.T) {
	data, err := os.ReadFile("testdata/check-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Source   string   `json:"source"`
		Problems []string `json:"problems"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	normalize := func(problems []string) []string {
		out := []string{}
		for _, p := range problems {
			if strings.HasPrefix(p, "MDX could not be parsed") {
				p = "MDX could not be parsed"
			}
			out = append(out, p)
		}
		return out
	}
	for i, c := range cases {
		got, want := normalize(Check(c.Source)), normalize(c.Problems)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("case %d:\n%s\n got: %q\nwant: %q", i, c.Source, got, want)
		}
	}
}

func TestStaticValues(t *testing.T) {
	for src, want := range map[string]any{
		`"a\nb"`:               "a\nb",
		"`tpl`":                "tpl",
		`-1.5`:                 -1.5,
		`0x10`:                 float64(16),
		`1e3`:                  float64(1000),
		`[1, "a", true, null]`: []any{float64(1), "a", true, nil},
		`'\u0041'`:             "A",
	} {
		n, single, err := parseProgram(src)
		if err != nil || !single || n.err != nil {
			t.Errorf("%s: err=%v single=%v static=%v", src, err, single, n.err)
			continue
		}
		if !reflect.DeepEqual(n.value, want) {
			t.Errorf("%s = %#v, want %#v", src, n.value, want)
		}
	}
	for src, want := range map[string]string{
		`alert(1)`:             "CallExpression is not a static value",
		`a.b`:                  "MemberExpression is not a static value",
		`1 + 2`:                "BinaryExpression is not a static value",
		`x`:                    `variables are not supported (found "x")`,
		`/re/`:                 "regular expressions and bigints are not supported",
		`10n`:                  "regular expressions and bigints are not supported",
		`!true`:                "operator ! is not supported",
		"`a ${b}`":             "template literals cannot interpolate ${...}",
		`[1,,2]`:               "arrays cannot contain holes or spreads",
		`{ [k]: 1 }`:           "objects may only contain plain key: value pairs",
		`{ a }`:                `variables are not supported (found "a")`,
		`() => 1`:              "ArrowFunctionExpression is not a static value",
		`{ "constructor": 1 }`: `object key "constructor" is not allowed`,
	} {
		n, _, err := parseProgram(src)
		if err != nil || n.err == nil || n.err.msg != want {
			t.Errorf("%s: got err=%v static=%v, want %q", src, err, n.err, want)
		}
	}
}

func TestFormatDetection(t *testing.T) {
	cases := map[string]string{
		"---\nid: a\nformat: mdx\n---\n# x": "mdx",
		"---\nformat: 'mdx'\n---\n":         "mdx",
		"# format: mdx":                     "md",
	}
	for src, want := range cases {
		if got := SourceFormat(src); got != want {
			t.Errorf("SourceFormat(%q) = %s, want %s", src, got, want)
		}
	}
	if got := StripFrontmatter("---\nformat: mdx\n---\n<Callout />"); got != "<Callout />" {
		t.Errorf("StripFrontmatter = %q", got)
	}
}

func TestCheckedInMDXDocsPass(t *testing.T) {
	root := filepath.Join("..", "..", "..", "docs")
	count := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".mdx") {
			return err
		}
		count++
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if SourceFormat(string(data)) != "mdx" {
			t.Errorf("%s must declare format: mdx", path)
		}
		if problems := Check(StripFrontmatter(string(data))); len(problems) > 0 {
			t.Errorf("%s: %v", path, problems)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("no MDX docs found")
	}
}
