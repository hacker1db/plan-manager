// Package exitcode defines the documented process exit codes and an error
// type that carries one.
package exitcode

import (
	"errors"
	"fmt"
)

const (
	OK                    = 0
	General               = 1
	InvalidInput          = 2
	NotFound              = 3
	Ambiguous             = 4
	Conflict              = 5
	PathTraversal         = 6
	StorageUnavailable    = 7
	DependencyUnavailable = 8
	PortCollision         = 9
)

// Error is an error that maps to a specific exit code. When Raw is true the
// message is written to stderr verbatim instead of with an "Error: " prefix.
type Error struct {
	Code int
	Msg  string
	Raw  bool
}

func (e *Error) Error() string { return e.Msg }

func New(code int, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// CodeOf returns the exit code carried by err, or General.
func CodeOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return General
}
