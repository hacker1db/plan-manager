# plan (Go)

A Go build of the `plan` CLI. It has the same commands, flags, JSON envelopes, and exit codes as the TypeScript CLI, and adds:

- **`plan tui`**: a full-screen manager for browsing, previewing, and changing plans.
- **Shell completion** for bash, zsh, fish, and PowerShell that completes plan slugs, statuses, subcommands, and file paths.
- **Live suggestions in the TUI command bar.** As you type, the bar lists what can come next, so you don't need to press Tab to find the next argument.
- **Pickers for missing arguments.** If you run `plan show`, `plan edit`, `plan status`, or `plan archive` in a terminal without an ID, `plan` asks you to choose one. Scripts and pipes still get exit code 2.
- **Colored output** for `plan list` and `plan show` when stdout is a terminal. Piped output is unchanged.

It is a single binary with the dashboard assets embedded, so it doesn't need Node.js at runtime. Pandoc is still needed to capture HTML and to render plans in the browser dashboard.

## Install

```sh
cd cli
go install ./cmd/plan          # installs to $(go env GOPATH)/bin/plan
plan doctor
```

If `pnpm link --global` already put the TypeScript `plan` on your PATH, make sure `$(go env GOPATH)/bin` comes first, or remove the old link with `pnpm unlink --global plan-manager`.

### Shell completion

```sh
# zsh: add to ~/.zshrc (needs `autoload -U compinit; compinit`)
source <(plan completion zsh)

# bash
source <(plan completion bash)

# fish
plan completion fish > ~/.config/fish/completions/plan.fish
```

Completions describe each candidate, for example `migrate-auth-service  Migrate auth service · active`. When a slug exists in both the plan home and `archive/`, completion offers the plan IDs instead, because the slug alone would be ambiguous.

Shells only show completions when you press Tab. To see suggestions while you type, use fish (it suggests automatically) or [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions), or use the TUI command bar described below.

## The TUI

```sh
plan tui        # or: plan ui
```

```
 ◆ plan  ~/notes/SecondBrain/4.Resources/plans          2 active · 1 completed · 0 archived
  1 All   2 Active   3 Completed   4 Archived
╭──────────────────────────────╮╭───────────────────────────────────────────────╮
│▌● Migrate auth service       ││ Migrate auth service                          │
│▌  active · 3h ago · #auth    ││ ● active  ·  updated 3h ago  ·  created 2d ago │
│                              ││ ━━━━━━━━━━──────────────────  1/3 tasks        │
│ ● Kubernetes upgrade         ││                                               │
│   active · 1d ago            ││   ## Tasks                                    │
│                              ││   [✓] Inventory current token flows           │
╰──────────────────────────────╯╰───────────────────────────────────────────────╯
 ↑/k up • / filter • e edit • s status • t tasks • n new • : command • ? more keys • q quit
```

| Key            | Action                                                      |
| -------------- | ----------------------------------------------------------- |
| `↑`/`↓`, `j`/`k` | Move through plans                                        |
| `/`            | Fuzzy-filter by title, tag, or slug                         |
| `1`–`4`, `[` `]` | Switch between All, Active, Completed, and Archived       |
| `tab` / `enter` | Move focus to the preview so you can scroll it             |
| `e`            | Open the plan in `$EDITOR`, then return to the TUI          |
| `s`            | Set the status (active, completed, or archived)             |
| `a`            | Archive the plan (asks first, then moves it to `archive/`)  |
| `t`            | Show the plan's `- [ ]` tasks; `space` or `x` toggles one   |
| `n`            | Create a plan and open it in `$EDITOR`                      |
| `o`            | Open the plan in the browser dashboard                      |
| `y`            | Copy the plan's file path                                   |
| `:`            | Open the command bar                                        |
| `r`            | Reload (changes on disk are also picked up every 2 seconds) |
| `?`            | Show all keys                                               |
| `q`            | Quit                                                        |

### Command bar

Press `:` to run any `plan` command with its usual syntax, for example `status migrate-auth-service completed`, `push --all`, or `capture ./doc.html --title "Design doc"`.

Suggestions appear below the input as you type and update on every keystroke. When you accept one with `tab` or `→`, the bar adds a space and immediately lists the options for the next argument. For example, accepting `status` lists your plans, and accepting a plan lists the three statuses. The highlighted suggestion is also shown inline as dim ghost text. Use `↑`/`↓` to choose a suggestion, `enter` to run the line, and `esc` to cancel.

Output from the command appears in the preview pane. Commands that need the terminal (`new`, `edit`, `auth login`, `serve --foreground`) take over the screen and then return to the TUI.

The command bar uses the same completion logic as the shell scripts, so the TUI and the shell always offer the same suggestions.

## Differences from the TypeScript CLI

- Unknown frontmatter keys are kept when a plan is rewritten. The TypeScript CLI dropped them.
- `plan doctor --json` reports `runtime: {ok, name, version}` instead of `node`.
- Unknown flags are rejected with exit code 2 instead of being ignored silently. To pass an argument that starts with `-`, put `--` before it: `plan search -- -rc1`.
- `plan push <id> --all` is rejected with exit code 2 instead of pushing only `<id>`.
- Frontmatter timestamps are written with double quotes (`"2026-…Z"`) instead of single quotes. Both implementations read either form.

## Development

```sh
go test ./...            # unit tests
./scripts/parity.sh      # runs the TypeScript CLI's node:test contract suites against this binary
go generate ./...        # refreshes the embedded dashboard from ../src/dashboard
```

`internal/server/dashboard/` is a copy of `src/dashboard/`, embedded with `go:embed`. A test fails if the copy goes stale.

| Package             | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `cmd/plan`          | Entry point                                                  |
| `internal/cmd`      | Cobra command tree, completion, and shared plan operations   |
| `internal/plans`    | Frontmatter, storage, path containment, IDs, and tasks       |
| `internal/lock`     | Write lock, compatible with the npm `proper-lockfile` layout |
| `internal/server`   | Local dashboard HTTP server, SSE, and HTML sanitizer         |
| `internal/service`  | Background dashboard probe and launcher                      |
| `internal/remote`   | Keychain credentials, Clerk PKCE login, and push             |
| `internal/tui`      | Bubble Tea TUI, command bar, and pickers                     |

Because the write lock uses the same on-disk protocol as `proper-lockfile`, the Go and TypeScript CLIs (and the dashboard servers) can run against the same plan home at the same time.
