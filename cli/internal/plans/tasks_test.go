package plans

import "testing"

func TestTasksAndToggle(t *testing.T) {
	body := "\n# Plan\n\n- [ ] First\n  - [x] Nested\n1. [ ] Numbered\n\nNot a task [ ]\n"
	tasks := Tasks(body)
	if len(tasks) != 3 || tasks[0].Text != "First" || !tasks[1].Checked || tasks[1].Depth != 1 || tasks[2].Text != "Numbered" {
		t.Fatalf("tasks = %+v", tasks)
	}
	out, ok := UpdateTaskMarker(body, 2, true)
	if !ok || Tasks(out)[2].Checked != true || Tasks(out)[0].Checked {
		t.Fatalf("toggle failed: %q", out)
	}
	if _, ok := UpdateTaskMarker(body, 9, true); ok {
		t.Fatal("out-of-range index should fail")
	}
}
