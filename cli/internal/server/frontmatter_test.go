package server

import (
	"strings"
	"testing"
)

func TestAliasBombPlanIsListedAsMalformed(t *testing.T) {
	var lines []string
	prev := "a"
	lines = append(lines, `a: &a ["x","x","x","x","x","x","x","x","x","x"]`)
	for _, name := range []string{"b", "c", "d", "e", "f"} {
		lines = append(lines, name+": &"+name+" ["+strings.TrimSuffix(strings.Repeat("*"+prev+",", 10), ",")+"]")
		prev = name
	}
	lines = append(lines, "tracking: ["+strings.TrimSuffix(strings.Repeat("*f,", 10), ",")+"]")
	bomb := planFile("bomb_plan", strings.Join(lines, "\n")+"\n", "Body\n")
	ts := startServer(t, map[string]string{"bomb.md": bomb, "ok.md": planFile("ok_plan", "", "fine\n")})
	status, res := ts.do("GET", "/api/plans", "")
	if status != 200 || !strings.Contains(res, "ok_plan") || strings.Contains(res, `"id":"bomb_plan"`) {
		t.Fatalf("status %d: %.400s", status, res)
	}
	var list struct {
		Malformed []malformed `json:"malformed"`
	}
	decode(t, res, &list)
	if len(list.Malformed) != 1 || list.Malformed[0].File != "bomb.md" {
		t.Fatalf("malformed = %+v", list.Malformed)
	}
}
