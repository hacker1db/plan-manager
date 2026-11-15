package mdxrender

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/hacker1db/plan-manager/cli/internal/mdx"
)

// The renderer keeps its own block registry. `plan blocks` and `plan check`
// read internal/mdx, so the two catalogs must stay identical or the dashboard
// would render blocks differently from what agents are told is valid.
func TestCatalogMatchesCheckerCatalog(t *testing.T) {
	ours, err := CatalogJSON()
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(ours, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(mdx.CatalogJSON(), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("mdxrender block catalog differs from internal/mdx; update both registries together")
	}
}
