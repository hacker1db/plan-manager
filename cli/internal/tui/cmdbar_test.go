package tui

import (
	"reflect"
	"testing"
)

func TestSplitArgs(t *testing.T) {
	cases := map[string][]string{
		`status my-plan completed`:         {"status", "my-plan", "completed"},
		`new "Migrate auth service"`:       {"new", "Migrate auth service"},
		`capture 'a b.html' --title "x y"`: {"capture", "a b.html", "--title", "x y"},
		`search it\'s`:                     {"search", "it's"},
		`  `:                               nil,
	}
	for in, want := range cases {
		if got := SplitArgs(in); !reflect.DeepEqual(got, want) {
			t.Errorf("SplitArgs(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCommandBarAcceptAdvancesToNextArgument(t *testing.T) {
	calls := []string{}
	b := newCommandBar(func(line string) []Suggestion {
		calls = append(calls, line)
		switch line {
		case "sta":
			return []Suggestion{{Value: "status"}}
		case "status ":
			return []Suggestion{{Value: "my-plan"}}
		}
		return nil
	})
	b.open("sta")
	if len(b.suggestions) != 1 {
		t.Fatalf("suggestions not shown while typing: %v", b.suggestions)
	}
	if !b.accept() {
		t.Fatal("accept failed")
	}
	if b.input.Value() != "status " {
		t.Fatalf("value = %q", b.input.Value())
	}
	if len(b.suggestions) != 1 || b.suggestions[0].Value != "my-plan" {
		t.Fatalf("next argument not suggested immediately: %v", b.suggestions)
	}
}
