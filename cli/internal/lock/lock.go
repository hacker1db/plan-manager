// Package lock implements the plan-home write lock. It uses the same on-disk
// protocol as the npm proper-lockfile package (an atomic mkdir of
// <root>/.write.lock whose mtime is refreshed while held and considered stale
// after 60s), so Go and Node writers exclude each other.
package lock

import (
	"encoding/json"
	"errors"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/hacker1db/plan-manager/cli/internal/exitcode"
)

const (
	timeout     = 10 * time.Second
	staleAfter  = 60 * time.Second
	refreshEach = 10 * time.Second
	retryEvery  = 25 * time.Millisecond
)

func timeoutErr(msg string) error { return exitcode.New(exitcode.Conflict, "%s", msg) }

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}

func legacyStale(path string) bool {
	if data, err := os.ReadFile(path); err == nil {
		var state struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(data, &state) == nil && state.PID > 0 {
			return !pidAlive(state.PID)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return true
	}
	return time.Since(info.ModTime()) > staleAfter
}

// removeStaleLegacyFile deletes a stale regular-file lock left by older
// versions that used a pid file instead of a directory.
func removeStaleLegacyFile(path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !legacyStale(path) {
		return false
	}
	return os.Remove(path) == nil
}

func waitForLegacyRecovery(lockPath string, deadline time.Time) error {
	recovery := lockPath + ".recovery"
	for {
		if removeStaleLegacyFile(recovery) {
			return nil
		}
		if _, err := os.Lstat(recovery); errors.Is(err, fs.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return timeoutErr("Timed out waiting for plan write-lock recovery to finish")
		}
		time.Sleep(retryEvery)
	}
}

func acquire(root string) (release func(), err error) {
	lockPath := filepath.Join(root, ".write.lock")
	deadline := time.Now().Add(timeout)
	if err := waitForLegacyRecovery(lockPath, deadline); err != nil {
		return nil, err
	}
	removeStaleLegacyFile(lockPath)
	for {
		err := os.Mkdir(lockPath, 0o777)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > staleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, timeoutErr("Timed out waiting for another plan write to finish")
		}
		time.Sleep(retryEvery + time.Duration(rand.IntN(25))*time.Millisecond)
	}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(refreshEach)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-t.C:
				_ = os.Chtimes(lockPath, now, now)
			}
		}
	}()
	return func() {
		close(done)
		_ = os.Remove(lockPath)
	}, nil
}

// With runs op while holding the write lock for root.
func With[T any](root string, op func() (T, error)) (T, error) {
	var zero T
	release, err := acquire(root)
	if err != nil {
		return zero, err
	}
	defer release()
	return op()
}
