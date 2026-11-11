// Package config reads the environment variables that locate the plan home
// and the local dashboard.
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const DefaultPort = 4173

func PlanHome() string {
	if v, ok := os.LookupEnv("PLAN_HOME"); ok {
		return v
	}
	return filepath.Join(homeDir(), "notes", "SecondBrain", "4.Resources", "plans")
}

func Port() int {
	// Like JavaScript's parseInt, accept a leading run of digits ("4173x").
	v := strings.TrimSpace(os.Getenv("PLAN_PORT"))
	end := 0
	for end < len(v) && v[end] >= '0' && v[end] <= '9' {
		end++
	}
	if n, err := strconv.Atoi(v[:end]); err == nil {
		return n
	}
	return DefaultPort
}

func Host() string {
	if v, ok := os.LookupEnv("PLAN_HOST"); ok {
		return v
	}
	return "127.0.0.1"
}

func DashboardURL(port int) string {
	return "http://plans.localhost:" + strconv.Itoa(port)
}

func PlanURL(id string) string {
	return DashboardURL(Port()) + "/plans/" + id
}

func homeDir() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return h
}

// HomeDir returns $HOME, falling back to the OS user home directory.
func HomeDir() string { return homeDir() }

// ConfigDir is the CLI's configuration directory: $XDG_CONFIG_HOME/plan-manager,
// defaulting to ~/.config/plan-manager.
func ConfigDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(homeDir(), ".config")
	}
	return filepath.Join(base, "plan-manager")
}
