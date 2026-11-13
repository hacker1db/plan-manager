package plans

import (
	"reflect"
	"testing"
)

func TestCommentsAndStrip(t *testing.T) {
	body := "# Plan <!-- plan-comment: rename -->\n\n" +
		"- [ ] First <!-- plan-comment: too vague --> <!--plan-comment:second-->\n" +
		"```md\nx <!-- plan-comment: not a comment -->\n```\n" +
		"Plain <!-- ordinary html comment -->\n"

	got := Comments(body)
	want := []Comment{{1, "rename"}, {3, "too vague"}, {3, "second"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Comments = %#v, want %#v", got, want)
	}

	stripped := StripComments(body)
	wantStripped := "# Plan\n\n- [ ] First\n" +
		"```md\nx <!-- plan-comment: not a comment -->\n```\n" +
		"Plain <!-- ordinary html comment -->\n"
	if stripped != wantStripped {
		t.Fatalf("StripComments =\n%q\nwant\n%q", stripped, wantStripped)
	}

	// Markers never disturb task numbering.
	if len(Tasks(body)) != len(Tasks(stripped)) {
		t.Fatal("stripping changed the task count")
	}
}

func TestFenceClosesOnlyWithMatchingMarker(t *testing.T) {
	body := "````\n```\nin <!-- plan-comment: code -->\n````\nout <!-- plan-comment: real -->"
	got := Comments(body)
	if len(got) != 1 || got[0].Line != 5 || got[0].Text != "real" {
		t.Fatalf("Comments = %#v", got)
	}
}
