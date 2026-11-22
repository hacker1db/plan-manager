package mdxrender

import (
	"strings"
	"testing"
)

const taskFixture = "<Diff filename=\"a.md\" before={`intro\n- [ ] not a task`} after=\"b\" />\n\n<Callout tone=\"risk\">\n- [ ] Real task\n- [x] Done task\n</Callout>\n\n  - [ ] Indented\n"

func TestSetTaskTogglesRenderedCheckboxes(t *testing.T) {
	if n := strings.Count(RenderHTML(taskFixture), `data-plan-task="true"`); n != 3 {
		t.Fatalf("rendered %d checkboxes", n)
	}
	next, ok := SetTask(taskFixture, 0, true)
	if !ok || next != strings.Replace(taskFixture, "- [ ] Real task", "- [x] Real task", 1) {
		t.Fatalf("index 0: ok=%v\n%s", ok, next)
	}
	next, ok = SetTask(taskFixture, 1, false)
	if !ok || next != strings.Replace(taskFixture, "- [x] Done task", "- [ ] Done task", 1) {
		t.Fatalf("index 1: ok=%v\n%s", ok, next)
	}
	next, ok = SetTask(taskFixture, 2, true)
	if !ok || next != strings.Replace(taskFixture, "- [ ] Indented", "- [x] Indented", 1) {
		t.Fatalf("index 2: ok=%v\n%s", ok, next)
	}
	if _, ok := SetTask(taskFixture, 3, true); ok {
		t.Fatal("index 3 accepted")
	}
}

// Dedenting element children shifts offsets; toggles must still land on the
// original source.
func TestSetTaskInsideDedentedElement(t *testing.T) {
	src := "<Tabs>\n  <Tab label=\"a\">\n    - [ ] nested\n  </Tab>\n</Tabs>\n"
	next, ok := SetTask(src, 0, true)
	if !ok || next != strings.Replace(src, "[ ]", "[x]", 1) {
		t.Fatalf("ok=%v\n%s", ok, next)
	}
}
