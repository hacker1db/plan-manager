package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/sys/unix"

	"github.com/hacker1db/plan-manager/cli/internal/config"
	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
	"github.com/hacker1db/plan-manager/cli/internal/plans"
	"github.com/hacker1db/plan-manager/cli/internal/server"
	"github.com/hacker1db/plan-manager/cli/internal/service"
)

func newOpenCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:               "open [id-or-slug]",
		Short:             "Open the dashboard (or one plan) in the browser",
		ValidArgsFunction: completePlanArg(true),
		RunE: func(c *cobra.Command, args []string) error {
			return runOpen(c, opts, args)
		},
	}
}

func runOpen(c *cobra.Command, opts *options, args []string) error {
	port := config.Port()
	url := config.DashboardURL(port)
	if len(args) > 0 {
		if err := plans.InitStorage(); err != nil {
			return err
		}
		p, err := plans.Resolve(args[0])
		if err != nil {
			return err
		}
		url = config.PlanURL(p.Meta.ID)
	}
	if _, err := service.Ensure(port, config.Host(), config.PlanHome()); err != nil {
		return &exitcode.Error{Code: exitcode.CodeOf(err), Raw: true, Msg: "Could not start plan dashboard: " + err.Error()}
	}
	if err := service.OpenURL(url); err != nil {
		fmt.Fprintf(os.Stderr, "Could not open browser: %s\n", err)
		fmt.Fprintf(c.OutOrStdout(), "Dashboard: %s\n", url)
	}
	return nil
}

func newInitCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "init",
		Short: "Create the plan home and archive directory",
		RunE: func(c *cobra.Command, args []string) error {
			if err := plans.InitStorage(); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(c.OutOrStdout(), map[string]any{"version": 1, "ok": true, "planHome": plans.Home(), "archiveDir": plans.ArchiveDir()})
			}
			fmt.Fprintf(c.OutOrStdout(), "Plan home initialized:\n  %s\n  %s\n", plans.Home(), plans.ArchiveDir())
			return nil
		},
	}
}

func newServeCmd(opts *options) *cobra.Command {
	var foreground bool
	c := &cobra.Command{
		Use:   "serve [--foreground]",
		Short: "Start the local dashboard",
		RunE: func(c *cobra.Command, args []string) error {
			port, host := config.Port(), config.Host()
			if !foreground {
				st, err := service.Ensure(port, host, config.PlanHome())
				if err != nil {
					return err
				}
				if opts.json {
					out := map[string]any{"version": 1, "dashboardUrl": st.DashboardURL, "serviceState": st.ServiceState, "started": st.Started, "port": port, "host": host}
					if st.PID != 0 {
						out["pid"] = st.PID
					}
					return writeJSON(c.OutOrStdout(), out)
				}
				verb := "running"
				if st.Started {
					verb = "started"
				}
				fmt.Fprintf(c.OutOrStdout(), "Plan dashboard %s at %s\n", verb, st.DashboardURL)
				return nil
			}
			srv, err := server.Start(server.Options{
				Port: port, Host: host, PlanHome: config.PlanHome(),
				NoWatch:           os.Getenv("PLAN_WATCH") == "0",
				WatchDebounce:     envMillis("PLAN_WATCH_DEBOUNCE_MS"),
				StabilityDelay:    envMillis("PLAN_STABILITY_DELAY_MS"),
				ReconcileInterval: envMillis("PLAN_RECONCILE_INTERVAL_MS"),
			})
			if err != nil {
				return err
			}
			if opts.json {
				_ = writeJSON(c.OutOrStdout(), map[string]any{"version": 1, "dashboardUrl": srv.URL, "serviceState": "running", "port": port, "host": host, "planHome": config.PlanHome()})
			} else {
				fmt.Fprintf(c.OutOrStdout(), "Plan dashboard running at %s\n", srv.URL)
			}
			sig := make(chan os.Signal, 1)
			signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
			<-sig
			srv.Close()
			return nil
		},
	}
	c.Flags().BoolVar(&foreground, "foreground", false, "run in this terminal instead of in the background")
	return c
}

// envMillis reads an optional duration override in milliseconds.
func envMillis(name string) time.Duration {
	n, err := strconv.Atoi(os.Getenv(name))
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Millisecond
}

func checkDir(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	if !info.IsDir() {
		return "not-a-directory"
	}
	return "ok"
}

func checkPandoc() map[string]any {
	out, err := exec.Command("pandoc", "--version").Output()
	if err != nil {
		return map[string]any{"ok": false, "version": nil}
	}
	version := "unknown"
	if m := regexp.MustCompile(`(?m)^pandoc\s+([\d.]+)`).FindSubmatch(out); m != nil {
		version = string(m[1])
	}
	return map[string]any{"ok": true, "version": version}
}

var (
	sandboxSection = regexp.MustCompile(`(?m)^\[sandbox_workspace_write\]\s*$`)
	writableRoots  = regexp.MustCompile(`(?ms)^\s*writable_roots\s*=\s*\[(.*?)\]`)
	tomlString     = regexp.MustCompile(`"((?:\\.|[^"])*)"|'([^']*)'`)
	nextSection    = regexp.MustCompile(`(?m)^\[`)
)

func parseWritableRoots(text string) []string {
	loc := sandboxSection.FindStringIndex(text)
	if loc == nil {
		return []string{}
	}
	section := text[loc[1]:]
	if next := nextSection.FindStringIndex(section); next != nil {
		section = section[:next[0]]
	}
	m := writableRoots.FindStringSubmatch(section)
	roots := []string{}
	if m == nil {
		return roots
	}
	for _, s := range tomlString.FindAllStringSubmatch(m[1], -1) {
		if s[1] != "" || strings.HasPrefix(s[0], `"`) {
			if v, err := strconv.Unquote(`"` + s[1] + `"`); err == nil {
				roots = append(roots, v)
			}
		} else {
			roots = append(roots, s[2])
		}
	}
	return roots
}

func checkCodex(root, home string) map[string]any {
	configPath := filepath.Join(home, ".codex", "config.toml")
	overridePath := filepath.Join(home, ".codex", "AGENTS.override.md")
	cfg, _ := os.ReadFile(configPath)
	override, _ := os.ReadFile(overridePath)
	rootAbs, _ := filepath.Abs(root)
	roots := parseWritableRoots(string(cfg))
	configured := false
	for _, r := range roots {
		if r == "~" || strings.HasPrefix(r, "~/") {
			r = home + r[1:]
		}
		if a, _ := filepath.Abs(r); a == rootAbs {
			configured = true
		}
	}
	return map[string]any{
		"configPath": configPath, "configuredWritableRoot": configured, "writableRoots": roots,
		"overridePath": overridePath, "overrideConflict": strings.TrimSpace(string(override)) != "",
	}
}

func checkLaunchAgent(home string) map[string]any {
	label := "com.plan-manager.serve"
	path := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
	info, err := os.Stat(path)
	installed := err == nil && info.Mode().IsRegular()
	res := map[string]any{"label": label, "path": path, "installed": installed, "loaded": false}
	missing := func(alt string) string {
		if installed {
			return alt
		}
		return "missing"
	}
	if runtime.GOOS != "darwin" {
		res["state"] = missing("unavailable")
		return res
	}
	out, err := exec.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)).Output()
	if err != nil {
		res["state"] = missing("unloaded")
		return res
	}
	res["loaded"] = true
	res["state"] = "loaded"
	if m := regexp.MustCompile(`\bstate = ([^\n]+)`).FindSubmatch(out); m != nil {
		res["state"] = strings.TrimSpace(string(m[1]))
	}
	if m := regexp.MustCompile(`\bpid = (\d+)`).FindSubmatch(out); m != nil {
		if pid, _ := strconv.Atoi(string(m[1])); pid != 0 {
			res["pid"] = pid
		}
	}
	return res
}

func checkAccess(path string) map[string]any {
	readable := unix.Access(path, unix.R_OK) == nil
	writable := unix.Access(path, unix.W_OK) == nil
	contained := plans.Contained(path)
	status := "unavailable"
	if readable && writable && contained {
		status = "ok"
	}
	return map[string]any{"readable": readable, "writable": writable, "contained": contained, "status": status}
}

func newDoctorCmd(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check the plan home, dashboard, and dependencies",
		RunE: func(c *cobra.Command, args []string) error {
			port := config.Port()
			root, archive, home := plans.Home(), plans.ArchiveDir(), config.HomeDir()
			rootStatus, archiveStatus := checkDir(root), checkDir(archive)
			access := checkAccess(root)
			svc := service.Probe(port, root)
			launch := checkLaunchAgent(home)
			codex := checkCodex(root, home)
			pandoc := checkPandoc()
			rt := map[string]any{"ok": true, "name": "go", "version": runtime.Version()}
			if opts.json {
				return writeJSON(c.OutOrStdout(), map[string]any{
					"version": 1, "dashboardUrl": svc.DashboardURL, "serviceState": svc.ServiceState, "service": svc,
					"planHome":   map[string]any{"path": root, "status": rootStatus, "access": access},
					"archiveDir": map[string]any{"path": archive, "status": archiveStatus},
					"runtime":    rt, "pandoc": pandoc, "launchAgent": launch, "codex": codex,
				})
			}
			w := c.OutOrStdout()
			pandocVersion, pandocState := "not found", "missing"
			if pandoc["ok"] == true {
				pandocVersion, pandocState = pandoc["version"].(string), "ok"
			}
			codexRoot, codexPolicy := "missing", "ok"
			if codex["configuredWritableRoot"] == true {
				codexRoot = "configured"
			}
			if codex["overrideConflict"] == true {
				codexPolicy = "shadowed by AGENTS.override.md"
			}
			fmt.Fprintf(w, "Plan home:    %s [%s; access %s]\n", root, rootStatus, access["status"])
			fmt.Fprintf(w, "Archive dir:  %s [%s]\n", archive, archiveStatus)
			fmt.Fprintf(w, "Runtime:      %s [ok]\n", runtime.Version())
			fmt.Fprintf(w, "Pandoc:       %s [%s]\n", pandocVersion, pandocState)
			fmt.Fprintf(w, "Dashboard:    %s [%s]\n", svc.DashboardURL, svc.ServiceState)
			fmt.Fprintf(w, "LaunchAgent:  %s [%s]\n", launch["label"], launch["state"])
			fmt.Fprintf(w, "Codex root:   %s\n", codexRoot)
			fmt.Fprintf(w, "Codex policy: %s\n", codexPolicy)
			return nil
		},
	}
}
