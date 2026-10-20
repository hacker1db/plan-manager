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

plan create --title "Auth recap" --format mdx --file recap.mdx --json
plan blocks                            # MDX block reference (--json for schemas)
plan check docs/recaps/auth.mdx        # validate MDX blocks; exits 2 on errors

plan status migrate-auth-service completed
plan archive migrate-auth-service
```

You can refer to a plan by its ID or its filename slug. Run `plan --help` to see every command.

Enable Tab completion (bash; zsh after `autoload -U bashcompinit && bashcompinit`) by adding `eval "$(plan completion bash)"` to your shell rc.

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
plan auth login          # opens Clerk authorization in your browser
plan push --all
plan auth status
```

There is a single hosted site, `https://planmanager.hacker1db.dev`; set `PLAN_MANAGER_URL` to point the CLI elsewhere (for example, a preview deployment). Push revisions are saved in `~/.config/plan-manager/site.json`. If the hosted copy changed since your last push, `plan push` refuses to overwrite it and exits with code 5. See [`docs/hosting.md`](docs/hosting.md) for Clerk Authorization Code + PKCE setup and legacy token management.

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

```
bin/plan            CLI entry point (runs dist/cli/index.js)
src/cli/            Argument parsing and one module per command
src/lib/            Storage, frontmatter, IDs, revisions, locking, service management
src/lib/mdx/        MDX block registry, static prop parser, and shared renderer
src/server/         Local dashboard HTTP server and JSON API
src/dashboard/      Canonical static dashboard assets (HTML, JS, CSS)
src/app/            Next.js routes for the same private hosted service
src/components/     Shared and hosted dashboard React components
src/hosted/         Hosted-only auth, storage, database, and migrations
test/               node:test suites for lib and CLI
docs/hosting.md     Hosted deployment and authentication guide
docs/recaps/        MDX recaps checked in alongside the changes they describe
.claude/skills/     visual-plan and visual-recap agent skills
```

## Development

```sh
pnpm dev           # local dashboard on a random free port (PLAN_PORT pins it), leaving 4173 to the installed CLI
pnpm dev:web       # Next.js app used by Vercel, locally
pnpm typecheck     # local CLI and hosted web app
pnpm test          # CLI/lib and hosted security/dashboard tests
pnpm build         # CLI and Vercel Next.js production builds
pnpm test:lib
pnpm test:cli
```

Tests run against the compiled `dist/` output, which is why each test script builds first.
