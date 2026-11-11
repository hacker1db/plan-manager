package tracking

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/hacker1db/plan-manager/cli/internal/config"
	"github.com/hacker1db/plan-manager/cli/internal/ordered"
)

type installation struct {
	InstallationID string `json:"installationId"`
	EnvironmentID  string `json:"environmentId"`
}

// loadInstallation returns this machine's stable identity, creating it on
// first use.
// shortcut: a copied config directory reuses the installation ID; detect clones (e.g. hostname drift) when backups make it happen.
func loadInstallation() (installation, error) {
	path := filepath.Join(config.ConfigDir(), "installation.json")
	unreadable := errors.New("Unreadable machine identity at " + path + "; fix or remove it")
	read := func() (installation, error) {
		var saved installation
		data, err := os.ReadFile(path)
		if err != nil {
			return saved, err
		}
		if json.Unmarshal(data, &saved) != nil || !uuidRe.MatchString(saved.InstallationID) || !uuidRe.MatchString(saved.EnvironmentID) {
			return saved, unreadable
		}
		return saved, nil
	}
	saved, err := read()
	if err == nil {
		return saved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return saved, unreadable
	}
	created := installation{InstallationID: NewUUID(), EnvironmentID: NewUUID()}
	if err := os.MkdirAll(config.ConfigDir(), 0o700); err != nil {
		return created, err
	}
	data, _ := json.MarshalIndent(created, "", "  ")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		// Another process created it first; use theirs so one machine keeps one identity.
		return read()
	}
	if err != nil {
		return created, err
	}
	defer f.Close()
	_, err = f.Write(append(data, '\n'))
	return created, err
}

// nodePlatform and nodeArch name the OS and CPU the way Node.js does, so
// machines look the same whichever CLI recorded them.
func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func nodeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	}
	return runtime.GOARCH
}

// LocalMachine returns this machine's identity and its host environment.
func LocalMachine() (machine, host *ordered.Obj, err error) {
	inst, err := loadInstallation()
	if err != nil {
		return nil, nil, err
	}
	hostname, _ := os.Hostname()
	display := os.Getenv("PLAN_MACHINE_NAME")
	if display == "" {
		display = hostname
	}
	machine = ordered.New().Set("installationId", inst.InstallationID).Set("displayName", display).
		Set("hostname", hostname).Set("os", nodePlatform()).Set("arch", nodeArch())
	host = ordered.New().Set("id", inst.EnvironmentID).Set("type", "host")
	return machine, host, nil
}
