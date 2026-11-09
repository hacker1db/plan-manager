package cmd

import (
	"strings"
	"testing"
)

func TestAuthLoginRejectsTokenFlagWithoutEchoingCredential(t *testing.T) {
	const credential = "pm_example_abcdefghijklmnopqrstuvwxyz012345"
	root := NewRoot()
	root.SetArgs([]string{"auth", "login", "--token", credential})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "unknown flag: --token") {
		t.Fatalf("expected --token rejection, got %v", err)
	}
	if strings.Contains(err.Error(), credential) {
		t.Fatal("rejected credential was echoed in the error")
	}
}
