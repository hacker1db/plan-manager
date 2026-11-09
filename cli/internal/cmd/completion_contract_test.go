package cmd

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Exercise Cobra's actual completion endpoint, which all generated shells use.
func TestCompletionCoversCommandFlags(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	var walk func(*cobra.Command, []string)
	walk = func(c *cobra.Command, path []string) {
		if c.Hidden {
			return
		}
		if len(path) > 0 {
			root := NewRoot()
			var out bytes.Buffer
			root.SetOut(&out)
			root.SetErr(&out)
			root.SetArgs(append(append([]string{"__complete"}, path...), "--"))
			if err := root.Execute(); err != nil {
				t.Fatalf("%v: %v", path, err)
			}
			got := map[string]bool{}
			for _, line := range strings.Split(out.String(), "\n") {
				name, _, _ := strings.Cut(line, "\t")
				got[name] = true
			}
			check := func(f *pflag.Flag) {
				if !f.Hidden && f.Deprecated == "" && !got["--"+f.Name] {
					t.Errorf("%v missing --%s: %s", path, f.Name, out.String())
				}
			}
			c.LocalNonPersistentFlags().VisitAll(check)
			c.InheritedFlags().VisitAll(check)
			c.PersistentFlags().VisitAll(check)
		}
		for _, child := range c.Commands() {
			walk(child, append(append([]string{}, path...), child.Name()))
		}
	}
	walk(NewRoot(), nil)
}

func TestCompletionFlagsAfterPlanArgument(t *testing.T) {
	t.Setenv("PLAN_HOME", t.TempDir())
	for _, line := range []string{"update example --", "push example --", "show example --"} {
		got := suggest(line)
		if !got["--json"] {
			t.Errorf("%s missing --json: %v", line, got)
		}
	}
	if got := suggest("update example --"); !got["--if-revision"] || !got["--file"] {
		t.Errorf("update flags: %v", got)
	}
	if got := suggest("push --"); !got["--all"] {
		t.Errorf("push flags: %v", got)
	}
}

func TestNativeShellCompletionScripts(t *testing.T) {
	for shell, marker := range map[string]string{"bash": "__start_plan", "zsh": "#compdef plan", "fish": "complete -c plan", "powershell": "Register-ArgumentCompleter"} {
		t.Run(shell, func(t *testing.T) {
			root := NewRoot()
			var out bytes.Buffer
			root.SetOut(&out)
			root.SetArgs([]string{"completion", shell})
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), marker) {
				t.Fatalf("missing native %s generator marker", shell)
			}
		})
	}
}

func TestBashCompletionTreatsCandidatesAsData(t *testing.T) {
	root := NewRoot()
	var script bytes.Buffer
	root.SetOut(&script)
	root.SetArgs([]string{"completion", "bash"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(t.TempDir(), "executed")
	payload := "$(touch${IFS}" + sentinel + ")"
	driver := script.String() + `
plan() { printf '%s\n' "$PAYLOAD" ':4'; }
COMP_WORDS=(plan show "")
COMP_CWORD=2
_plan
printf '%s\n' "${COMPREPLY[@]}"
`
	command := exec.Command("bash", "-c", driver)
	command.Env = append(os.Environ(), "PAYLOAD="+payload)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatal("completion evaluated shell syntax")
	}
	if !strings.Contains(strings.ReplaceAll(string(out), "\\", ""), payload) {
		t.Fatalf("literal candidate missing: %s", out)
	}
}
