package plans

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// aliasBomb is about 500 bytes of frontmatter whose final key expands to
// ten million nodes.
func aliasBomb(key string) string {
	lines := []string{"id: bomb_plan", "title: Bomb", `a: &a ["x","x","x","x","x","x","x","x","x","x"]`}
	prev := "a"
	for _, name := range []string{"b", "c", "d", "e", "f"} {
		lines = append(lines, name+": &"+name+" ["+strings.TrimSuffix(strings.Repeat("*"+prev+",", 10), ",")+"]")
		prev = name
	}
	lines = append(lines, key+": ["+strings.TrimSuffix(strings.Repeat("*f,", 10), ",")+"]")
	return "---\n" + strings.Join(lines, "\n") + "\n---\nBody\n"
}

func TestAliasBombIsRejectedQuickly(t *testing.T) {
	for _, key := range []string{"tracking", "unknownKey"} {
		t.Run(key, func(t *testing.T) {
			src := aliasBomb(key)
			if len(src) > 600 {
				t.Fatalf("bomb is %d bytes", len(src))
			}
			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			start := time.Now()
			raw, body := ParseFrontmatter(src)
			meta := NormalizeMeta(raw)
			took := time.Since(start)
			runtime.ReadMemStats(&after)
			if took > time.Second {
				t.Errorf("took %v", took)
			}
			if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
				t.Errorf("allocated %d bytes", alloc)
			}
			if _, ok := raw.Str("id"); ok || meta.Tracking != nil || len(meta.Extra) != 0 {
				t.Errorf("bomb frontmatter was accepted: %+v", meta)
			}
			if body != "Body\n" {
				t.Errorf("body = %q", body)
			}
		})
	}
}

func TestAliasCycleIsRejected(t *testing.T) {
	raw, _ := ParseFrontmatter("---\nid: cycle_plan\nloop: &a [*a]\n---\n")
	if _, ok := raw.Str("id"); ok {
		NormalizeMeta(raw)
		t.Fatal("cyclic frontmatter was accepted")
	}
}

func TestSmallAliasesStillWork(t *testing.T) {
	raw, _ := ParseFrontmatter("---\nid: alias_plan\ntitle: A\ndefaults: &d {owner: me}\nextra: *d\n---\n")
	meta := NormalizeMeta(raw)
	if meta.ID != "alias_plan" || len(meta.Extra) != 2 || meta.Extra[1].Value.Content[1].Value != "me" {
		t.Fatalf("meta = %+v", meta)
	}
}
