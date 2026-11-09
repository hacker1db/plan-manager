// Package service probes and starts the background dashboard server.
package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/config"
	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
)

type Health struct {
	Status   string `json:"status"`
	Service  string `json:"service"`
	Version  int    `json:"version"`
	URL      string `json:"url"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	PlanHome string `json:"planHome"`
	Pandoc   string `json:"pandoc"`
}

type State struct {
	DashboardURL string  `json:"dashboardUrl"`
	ServiceState string  `json:"serviceState"`
	Owned        bool    `json:"owned"`
	Port         int     `json:"port"`
	Health       *Health `json:"health,omitempty"`
	Error        string  `json:"error,omitempty"`
	Started      bool    `json:"-"`
	PID          int     `json:"-"`
}

func samePath(a, b string) bool {
	ca, _ := filepath.Abs(a)
	cb, _ := filepath.Abs(b)
	return filepath.Clean(ca) == filepath.Clean(cb)
}

// Probe reports whether a plan-manager dashboard for planHome is listening on port.
func Probe(port int, planHome string) State {
	st := State{DashboardURL: config.DashboardURL(port), Port: port, ServiceState: "stopped"}
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/_health", nil)
	req.Host = "plans.localhost:" + strconv.Itoa(port)
	client := &http.Client{Timeout: 750 * time.Millisecond}
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return st
		}
		st.ServiceState = "error"
		st.Error = err.Error()
		return st
	}
	defer res.Body.Close()
	var h Health
	data, _ := io.ReadAll(io.LimitReader(res.Body, 65536))
	parseErr := json.Unmarshal(data, &h)
	owned := parseErr == nil && res.StatusCode == 200 && h.Service == "plan-manager" && h.Version == 1 &&
		(h.Status == "ok" || h.Status == "degraded") && h.PlanHome != ""
	if !owned {
		st.ServiceState = "error"
		st.Error = "port is occupied by a service that is not plan-manager"
		return st
	}
	st.Owned = true
	st.Health = &h
	if !samePath(h.PlanHome, planHome) {
		st.ServiceState = "error"
		st.Error = "plan-manager is serving a different plan home: " + h.PlanHome
		return st
	}
	st.ServiceState = "running"
	return st
}

// Ensure returns the running dashboard, starting `plan serve --foreground`
// in the background when nothing is listening.
func Ensure(port int, host, planHome string) (State, error) {
	cur := Probe(port, planHome)
	switch cur.ServiceState {
	case "running":
		return cur, nil
	case "error":
		return cur, exitcode.New(exitcode.PortCollision, "%s", cur.Error)
	}
	self, err := os.Executable()
	if err != nil {
		return cur, exitcode.New(exitcode.DependencyUnavailable, "%s", err.Error())
	}
	cmd := exec.Command(self, "serve", "--foreground")
	cmd.Env = append(os.Environ(),
		"PLAN_HOME="+planHome, "PLAN_PORT="+strconv.Itoa(port), "PLAN_HOST="+host)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return cur, exitcode.New(exitcode.DependencyUnavailable, "%s", err.Error())
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	for range 40 {
		time.Sleep(50 * time.Millisecond)
		st := Probe(port, planHome)
		if st.ServiceState == "running" {
			st.Started, st.PID = true, pid
			return st, nil
		}
		if st.ServiceState == "error" {
			return st, exitcode.New(exitcode.PortCollision, "%s", st.Error)
		}
	}
	return cur, exitcode.New(exitcode.DependencyUnavailable, "plan-manager did not become healthy at %s", config.DashboardURL(port))
}

// OpenURL opens url with PLAN_BROWSER or the platform opener.
func OpenURL(url string) error {
	opener, ok := os.LookupEnv("PLAN_BROWSER")
	if !ok {
		opener = "xdg-open"
		if runtime.GOOS == "darwin" {
			opener = "open"
		}
	}
	cmd := exec.Command(opener, url)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w", err)
	}
	return nil
}
