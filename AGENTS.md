# Agent guide: plan-manager

## Branches and deployments

| Branch | Deploys to | Vercel environment | WorkOS environment |
| --- | --- | --- | --- |
| `preview` | https://preview.planmanager.hacker1db.dev | Preview (branch `preview`) | plan manager › Staging |
| `main` | https://planmanager.hacker1db.dev | Production | plan manager › Production |

- **Open every feature, fix, and chore pull request against `preview`**, not `main`:
  `gh pr create --base preview ...`. Branch new work from `origin/preview`.
- Do not open pull requests into `main` and do not push to `main` or `preview` directly.
  The only PR into `main` is the release PR from `preview`.
- Production is promoted on the owner's request only. Run `pnpm promote`
  (or `/promote`) to open the release PR `preview` → `main`; `pnpm promote --dry-run`
  previews it. Never merge the release PR yourself.
- The release PR is merged with a **merge commit**, never squashed, so the
  branches keep a shared history.
- A hotfix that had to land on `main` is followed by a PR that merges `main` back into `preview`.

## Pull requests and issues

- Every PR references a GitHub issue (`Closes #n`, `Fixes #n`, or `Refs #n`). Search for an
  existing issue before creating one.
- Issues close when the release PR lands on `main`; `pnpm promote` copies the closing
  references of every included PR into the release PR.

## Environments

- Preview and Production have separate Neon databases, private Blob stores, token peppers,
  cookie passwords, and WorkOS environments. Never point Preview at production data or reuse
  production secrets there.
- Never print, commit, or copy secret values. Required variables are listed in
  [`docs/hosting.md`](docs/hosting.md); `.env.example` holds names only.
- Schema changes are applied intentionally (`pnpm db:migrate`), to Preview first.

## Checks before opening a PR

```sh
pnpm typecheck && pnpm test
```

`pnpm test:contracts` covers the Go CLI's black-box behavior; run it when `cli/` changes.
The local dashboard in `cli/internal/server/dashboard` is generated from `src/dashboard`
(`go generate ./internal/server`); edit `src/dashboard` and regenerate.
