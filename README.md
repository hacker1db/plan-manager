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
- **CLI for people and scripts.** Most commands accept `--json` and return documented exit codes, so agents and scripts can create and update plans safely.
- **Safe writes.** Writes are atomic and use a lock. Paths that escape the plan home are rejected, and `--if-revision` guards against overwriting someone else's changes.
- **Local dashboard.** Browse, search, filter by status, and check off tasks at `http://plans.localhost:4173`. The page refreshes live when files change on disk.
- **Capture.** Turn an existing Markdown or HTML file into a plan. HTML is converted with Pandoc. Capturing the same source again updates the existing plan instead of creating a duplicate.
- **Optional hosted viewer.** `plan push` uploads plans to the private Next.js app in `src/app` (see [`docs/hosting.md`](docs/hosting.md)). Your local Markdown stays the source of truth.

## Requirements

- Node.js 20 or later
- pnpm 10 (`corepack enable`)
- [Pandoc](https://pandoc.org/), only needed to capture HTML
- macOS, only needed for remote credentials (stored in Keychain)

## Installation

```sh
pnpm install
pnpm build
pnpm link --global   # puts `plan` on your PATH
plan init            # creates the plan home and archive directory
plan doctor          # checks your setup
```

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

plan status migrate-auth-service completed
plan archive migrate-auth-service
```

You can refer to a plan by its ID or its filename slug. Run `plan --help` to see every command.

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

### Dashboard

`plan serve` starts the dashboard as a background service. `plan serve --foreground` runs it in the current terminal instead. The server listens only on `127.0.0.1` and checks the `plans.localhost` host name.

### JSON output and exit codes

Commands that change or return a plan print a versioned envelope when you pass `--json`:

```json
{ "version": 1, "id": "…", "title": "…", "status": "active", "path": "…", "url": "http://plans.localhost:4173/plans/…", "revision": "…", "created": "…", "updated": "…", "tags": [] }
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
plan remote add personal https://planmanager.example.com
pbpaste | plan auth login personal --stdin   # token is stored in macOS Keychain
plan push --all --remote personal
plan remote status personal
```

The remote configuration is saved in `~/.config/plan-manager/remotes.json`. If the remote copy changed since your last push, `plan push` refuses to overwrite it and exits with code 5. See [`docs/hosting.md`](docs/hosting.md) for deployment, authentication, and token management.

## Configuration

| Variable                         | Default               | Purpose                                     |
| -------------------------------- | --------------------- | ------------------------------------------- |
| `PLAN_HOME`                      | `~/notes/SecondBrain/4.Resources/plans` | Directory where plans are stored  |
| `PLAN_PORT`                      | `4173`                | Dashboard port                              |
| `PLAN_HOST`                      | `127.0.0.1`           | Address the dashboard listens on            |
| `PLAN_PANDOC`                    | `pandoc`              | Pandoc executable used by `capture`         |
| `XDG_CONFIG_HOME`                | `~/.config`           | Base directory for the remote configuration |
| `EDITOR` / `VISUAL`              | `vi`                  | Editor used by `new` and `edit`             |
| `DEBUG`                          | —                     | Print stack traces for unexpected errors    |

## Project layout

```
bin/plan            CLI entry point (runs dist/cli/index.js)
src/cli/            Argument parsing and one module per command
src/lib/            Storage, frontmatter, IDs, revisions, locking, service management
src/server/         Local dashboard HTTP server and JSON API
src/dashboard/      Canonical static dashboard assets (HTML, JS, CSS)
src/app/            Next.js routes for the same private hosted service
src/components/     Shared and hosted dashboard React components
src/hosted/         Hosted-only auth, storage, database, and migrations
test/               node:test suites for lib and CLI
docs/hosting.md     Hosted deployment and authentication guide
```

## Development

```sh
pnpm dev           # local dashboard at plans.localhost:4173
pnpm dev:web       # Next.js app used by Vercel, locally
pnpm typecheck     # local CLI and hosted web app
pnpm test          # CLI/lib and hosted security/dashboard tests
pnpm build         # CLI and Vercel Next.js production builds
pnpm test:lib
pnpm test:cli
```

Tests run against the compiled `dist/` output, which is why each test script builds first.
