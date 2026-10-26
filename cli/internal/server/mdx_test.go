package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMDXPlansAreListedAndShownAsSource(t *testing.T) {
	home := t.TempDir()
	body := "<Callout tone=\"risk\">\n- [ ] Inside\n</Callout>\n"
	plan := "---\nid: mdx_plan\ntitle: Visual\nstatus: active\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\ntags: []\n---\n" + body
	if err := os.WriteFile(filepath.Join(home, "visual.mdx"), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Start(Options{Host: "127.0.0.1", PlanHome: home, NoWatch: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(s.Port)+"/api/plans/mdx_plan", nil)
	req.Host = "plans.localhost:" + strconv.Itoa(s.Port)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var detail struct {
		Format      string  `json:"format"`
		HTML        *string `json:"html"`
		RenderState string  `json:"renderState"`
		Body        string  `json:"body"`
	}
	if err := json.NewDecoder(res.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || detail.Format != "mdx" || detail.HTML != nil || detail.RenderState != "unavailable" || !strings.Contains(detail.Body, "<Callout") {
		t.Errorf("status %d, detail %+v", res.StatusCode, detail)
	}
}
