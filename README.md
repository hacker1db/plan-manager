# Plan Manager

A local-first library for Markdown plans. Plans are plain `.md` files with YAML frontmatter, stored in one directory you own. A `plan` CLI and a local web dashboard sit on top of that directory. You can also push plans to an optional private hosted viewer.

```
~/notes/SecondBrain/4.Resources/plans/
├── migrate-auth-service.md
├── q4-roadmap.md
└── archive/
    └── old-idea.md
```

## Features

- **Plain files.** Each plan is a Markdown file you can edit with any editor or keep in Git.
- **Visual MDX plans.** An `.mdx` plan can mix Markdown with typed blocks such as file trees, diffs, data models, endpoint contracts, flows, and open questions. The MDX is parsed but never executed, and the source stays readable in Git.
- **CLI for people and scripts.** Most commands accept `--json` and return documented exit codes, so agents and scripts can create and update plans safely.
- **Safe writes.** Writes are atomic and use a lock. Paths that escape the plan home are rejected, and `--if-revision` guards against overwriting someone else's changes.
- **Local dashboard.** Browse, search, filter by status, and check off tasks at `http://plans.localhost:4173`. The page refreshes live when files change on disk.
- **Capture.** Turn an existing Markdown or HTML file into a plan. HTML is converted with Pandoc. Capturing the same source again updates the existing plan instead of creating a duplicate.
- **Optional hosted viewer.** `plan push` uploads plans to the private SvelteKit app in `src/routes` (see [`docs/hosting.md`](docs/hosting.md)). Your local Markdown stays the source of truth.

## Requirements

- Go (version specified in `cli/go.mod`) to build the CLI; no Node runtime is needed to run it.
- Node.js 22.17+ and pnpm 10 for the hosted SvelteKit app and JavaScript contract tests.
- Pandoc for HTML capture; macOS Keychain for remote credentials.

## Installation

```sh
cd cli
go install ./cmd/plan
# Ensure $(go env GOPATH)/bin is on PATH.
plan doctor --json
```

Re-run `go install ./cmd/plan` after pulling CLI updates. Remove any old npm-linked
`plan` shim from PATH and verify `command -v plan` points to the Go binary.

For zsh, initialize `compinit`, then `source <(plan completion zsh)` in `.zshrc`.
For bash, use `source <(plan completion bash)`. Fish and PowerShell scripts are
available through `plan completion fish` and `plan completion powershell`.

The TypeScript CLI has been removed. The Go command tree (`plan --help`) is the
supported CLI surface, including journey tracking (`stage`, `review`, `session`,
`pr`, `complete`, `reopen`), `.mdx` plans, `blocks`/`check`, and in-process MDX
rendering in the local dashboard.

## Usage

```sh
plan                                   # open the dashboard (starts it if needed)
plan new "Migrate auth service"        # create a plan and open it in $EDITOR
plan create --title "Q4 roadmap" --file roadmap.md --json
echo "# Notes" | plan create --title "Scratch" --stdin
plan import ./existing-plan.md
plan capture ./design-doc.html --title "Design doc"

plan list --status active
plan search "auth"
plan show migrate-auth-service --json
plan edit migrate-auth-service
plan update migrate-auth-service --file new.md --if-revision <sha256>

plan create --title "Auth recap" --format mdx --file recap.mdx --json
plan blocks                            # MDX block reference (--json for schemas)
plan check docs/recaps/auth.mdx        # validate MDX blocks; exits 2 on errors

plan status migrate-auth-service completed
plan archive migrate-auth-service
```

You can refer to a plan by its ID or its filename slug. Run `plan --help` to see every command.

Enable Tab completion (bash; zsh after `autoload -U bashcompinit && bashcompinit`) by adding `eval "$(plan completion bash)"` to your shell rc.

### Go CLI and terminal UI

[`cli/`](cli/README.md) contains a Go build of the same CLI. It has identical commands, JSON output, and exit codes, and adds `plan tui` (a full-screen plan manager), shell completion for plan slugs and statuses, and a command bar that suggests the next argument as you type. Install it with `cd cli && go install ./cmd/plan`.

### Plan format

```markdown
---
id: V1StGXR8_Z5jdHi6B-myT
title: Migrate auth service
status: active          # active | completed | archived
created: 2026-10-04T20:00:00.000Z
updated: 2026-10-04T20:00:00.000Z
tags: [backend, auth]
source: /path/to/original.html   # set by `plan capture`
---

## Tasks

- [ ] Inventory current token flows
- [x] Draft rollout plan
```

Missing fields get default values when the file is read. The `revision` reported by `--json` output is the SHA-256 hash of the whole file.

### MDX plans

Save a plan as `<slug>.mdx`, or pass `--format mdx` to `new` or `create`, and its body can use block components alongside ordinary Markdown:

```mdx
---
id: V1StGXR8_Z5jdHi6B-myT
title: "Recap: MDX plans"
status: active
format: mdx
---

Plans can now carry structured review blocks.

<FileTree files={[{ path: "src/lib/mdx/render.tsx", change: "added", additions: 495 }]} />

<Callout tone="decision" title="Parse, never evaluate">
Props must be static literals; imports and expressions render as errors.
</Callout>
```

`plan blocks` prints every block with its props and an example. The output comes from the same registry the renderer validates against. Before you commit or push an MDX file, run `plan check <file|id>` to catch unknown tags, missing props, or parse errors. `format: mdx` in the frontmatter is how the hosted site knows to render the blocks after `plan push`, and `plan create` and `plan update` write it for you. The repo ships `visual-plan` and `visual-recap` agent skills in `.claude/skills/` that author these files. See [`docs/recaps/mdx-visual-plans.mdx`](docs/recaps/mdx-visual-plans.mdx) for a worked example.

### Tracking sessions, PRs and stages

A plan can record its journey stage (`planning`, `awaiting_plan_review`, `in_progress`, `awaiting_pr_review`, `completed`), the agent sessions working on it, and the pull requests that implement it:

```sh
plan stage migrate-auth-service awaiting_plan_review          # submit the current body for review
plan review record migrate-auth-service plan --decision approved
plan stage migrate-auth-service in_progress
echo '{"provider":"claude","nativeSessionId":"…","branch":"feat/auth"}' \
  | plan session attach migrate-auth-service --stdin --idempotency-key run-42 --json
plan session end migrate-auth-service <execution-id>
plan pr attach migrate-auth-service https://github.com/owner/repo/pull/12 --role implements
plan stage migrate-auth-service awaiting_pr_review
plan review record migrate-auth-service pr https://github.com/owner/repo/pull/12 --state approved --head <sha>
plan pr refresh migrate-auth-service       # re-reads PR state with gh
plan complete migrate-auth-service --reason "shipped"
plan reopen migrate-auth-service --stage in_progress --reason "regression"
```

Stage changes are guarded. Work starts only after the submitted plan is approved, and the approval covers the exact plan body (a sha256 of the body, not the frontmatter): editing the body afterwards makes it stale until it is resubmitted and reviewed again. `awaiting_pr_review` needs an attached PR that is open (not draft). `plan stage … completed` is refused; `plan complete` requires a current plan approval and every `implements` PR merged with an approved review of its current head SHA, or `--no-pr-rationale` when no PR is attached. A push after a PR review makes that review stale, and a PR approval never counts as plan approval. `plan reopen` keeps the completion in the history.

These commands append events to a validated `tracking` block in the frontmatter; nothing is rewritten in place. The first event on an existing plan records how it was migrated (an `active` plan starts in `planning`, a `completed` one keeps a legacy completion with unknown review history). Retrying a command with the same `--idempotency-key` changes nothing. A merged PR never moves the stage on its own, and `plan status` refuses to contradict the tracked stage. Each machine gets a random installation ID in `~/.config/plan-manager/installation.json`, so two machines with the same hostname stay distinct. Unknown frontmatter fields are preserved on every write, and a plan written by a newer tracking schema refuses writes from an older `plan` instead of losing data.

### Dashboard

`plan serve` starts the dashboard as a background service. `plan serve --foreground` runs it in the current terminal instead. The server listens only on `127.0.0.1` and checks the `plans.localhost` host name.

### JSON output and exit codes

Commands that change or return a plan print a versioned envelope when you pass `--json`:

```json
{ "version": 1, "id": "…", "title": "…", "status": "active", "path": "…", "url": "http://plans.localhost:4173/plans/…", "revision": "…", "created": "…", "updated": "…", "tags": [], "stage": "planning" }
```

| Code | Meaning                  |
| ---- | ------------------------ |
| 0    | Success                  |
| 2    | Invalid input            |
| 3    | Not found                |
| 4    | Ambiguous identifier     |
| 5    | Revision conflict        |
| 6    | Path traversal rejected  |
| 7    | Storage unavailable      |
| 8    | Dependency unavailable   |
| 9    | Port collision           |

### Pushing to a hosted remote

```sh
plan auth login          # starts WorkOS device authorization
plan push --all
plan auth status
```

There is a single hosted site, `https://planmanager.hacker1db.dev`; set `PLAN_MANAGER_URL` to point the CLI elsewhere (for example, a preview deployment). Push revisions are saved in `~/.config/plan-manager/site.json`. If the hosted copy changed since your last push, `plan push` refuses to overwrite it and exits with code 5. See [`auth.md`](auth.md) and [`docs/hosting.md`](docs/hosting.md) for WorkOS setup and legacy-token boundaries.

## Configuration

| Variable                         | Default               | Purpose                                     |
| -------------------------------- | --------------------- | ------------------------------------------- |
| `PLAN_HOME`                      | `~/notes/SecondBrain/4.Resources/plans` | Directory where plans are stored |
| `PLAN_PORT`                      | `4173`                | Dashboard port                              |
| `PLAN_HOST`                      | `127.0.0.1`           | Address the dashboard listens on            |
| `PLAN_PANDOC`                    | `pandoc`              | Pandoc executable used by `capture`         |
| `XDG_CONFIG_HOME`                | `~/.config`           | Base directory for the remote configuration |
| `EDITOR` / `VISUAL`              | `vi`                  | Editor used by `new` and `edit`             |
| `DEBUG`                          | —                     | Print stack traces for unexpected errors    |

## Project layout

- `cli/`: Go CLI, local HTTP server, TUI, completion, and tests.
- `src/dashboard/`: canonical dashboard assets embedded by Go and used by the hosted app.
- `src/routes/` and `src/lib/server/`: hosted SvelteKit app.
- `src/lib/`: shared plan metadata and safe Markdown/MDX rendering helpers.
- `test/lib/` and `test/hosted/`: shared-library and hosted tests, run directly with tsx.

## Development

```sh
pnpm install
pnpm dev           # Go local dashboard
pnpm dev:web       # hosted SvelteKit app
pnpm build:cli     # Go binary at cli/bin/plan
pnpm typecheck:cli # go vet
pnpm test:cli      # Go tests, including completions
pnpm test:contracts # historical black-box contracts against Go
pnpm typecheck     # hosted/shared TypeScript
pnpm test          # Go, shared libraries, hosted tests
pnpm build         # hosted production build; no TypeScript CLI emitted
```
