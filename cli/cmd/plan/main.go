// Command plan manages a local library of Markdown plans.
package main

import (
	"os"

	"github.com/hacker1db/plan-manager/cli/internal/cmd"
)

func main() {
	os.Exit(cmd.Execute(os.Args[1:]))
}
