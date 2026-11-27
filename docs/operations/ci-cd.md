# CI/CD operations guide

This guide is for the repository owner. It says what each pipeline piece does, what you must set
up by hand before it works, and what was and was not proven. You should not need to read the code.
The plan and its review record are in [`ci-cd-plan.md`](ci-cd-plan.md).

Nothing in this repository changes live Vercel or GitHub settings, creates secrets, or reads
secret values. Every such step is listed here as an **operator prerequisite** for you to do.

## Assumptions

These were not confirmed by the owner. If one is wrong, the sections marked with it need a change.

| ID | Assumption | Where it matters |
| --- | --- | --- |
| A1 | Vercel **Hobby** plan: no team, no separate automation member, rollback only to the immediately previous production deployment. | Release and rollback |
| A2 | One **personal Vercel token**, stored only in GitHub environments whose deployment branch policy is `main`. | Drift audit, preview smoke, release |
| A3 | **Two Vercel projects** (preview and production) are acceptable. | Drift audit, preview smoke, release |
| A4 | No `hacker1dbai` GitHub identity is available yet, so PRs are opened by `hacker1db`. | Review rules |

## Environment contract

`config/env.contract.json` lists every environment variable by name, with where it is required,
whether it is a secret, the check the production build applies, the minimum Vercel storage type,
an obviously fake CI fixture, and an owner. The production build guard
(`scripts/check-hosted-env.mjs`), the runtime (`src/lib/server/env.ts`), the Vercel name inventory
(`pnpm check:vercel-env`), the CI fixture build, and the client bundle scan all read it.

| Command | What it does |
| --- | --- |
| `pnpm contract:generate` | Rewrites `src/lib/server/env.contract.ts`, `src/env.ts`, `.env.example` and the table in `docs/hosting.md`, always in that order. |
| `pnpm contract:check` | Fails if any of those files is out of date with the contract. |

To add a variable: add it to the contract, run `pnpm contract:generate`, set the real value in
Vercel for every target the contract lists, then merge. The production build fails closed if you
skip the Vercel step.

### Operator prerequisites (contract)

None to merge. Recommended: in both Vercel projects, change every variable whose contract
sensitivity is `secret` to the **Sensitive** storage type for Production and Preview
(Development stays **Encrypted**; Vercel does not offer Sensitive there). To change the type you
must remove and re-add the variable, typing the value at the prompt
(`vercel env add <NAME> production --sensitive`). Do this one variable at a time and redeploy.

## Pull request CI (`ci.yml`)

Runs the PR's own code with no secrets and read-only permissions. Jobs: environment contract,
typecheck (web and `go vet`), tests (`pnpm test`, `pnpm test:contracts`), production-equivalent
build (fixture build must pass; empty-environment build must fail naming every variable),
contract-change gate (PRs only), workflow lint (actionlint and zizmor), and `ci-required`, which
fails unless every other job succeeded. There is no lint job because the repository has no lint
script. No caches are used, so a PR cannot poison a cache that a trusted workflow later reads.

### Contract-change gate

A PR fails the gate when it adds a variable required in Vercel production, makes an existing
variable production-required, adds a secret a GitHub environment must hold, or changes a variable's
build check. Those changes would break the next production build or release unless the real value
exists first. To pass it, the **repository owner** (not the agent identity) must:

1. Set each listed variable in Vercel (or in the named GitHub environment) with its real value.
   Check names only with `pnpm check:vercel-env`.
2. Confirm on the PR's head commit:
   `gh api repos/hacker1db/plan-manager/statuses/<head-sha> -f state=success -f context=env-provisioned -f description="Provisioned"`
3. Re-run the failed **Contract-change gate** job. A new push needs a new status.

The gate reads statuses with the workflow's read-only token and ignores any `env-provisioned`
status not created by the repository owner. A label is not used, because anyone with write access
can add one.

### Code owners

`.github/CODEOWNERS` assigns every path (`* @hacker1db`) to the owner, so a PR that edits a
workflow, a CI script, the contract, `package.json`, source, or tests cannot merge without the
owner's review.

### Operator prerequisites (PR CI)

Do these in GitHub → Settings → Rules → Rulesets → `main` after the `ci` workflow has run at least
once on `main`:

1. Under **Require status checks to pass**, add `ci-required` with source **GitHub Actions**
   (choosing the source stops another app or a commit status from satisfying it).
   Leave the existing "Require deployments to succeed: Preview" rule until the preview project
   exists (see the release section), then change it to that project's environment name.
2. Under **Require a pull request before merging**, turn on **Require review from Code Owners**.
   Keep 1 required approval, **Require approval of the most recent reviewable push**, and
   **Dismiss stale pull request approvals** as they are now.
3. Keep bypass limited to the repository admin role. Every bypass is an incident: say why in the
   PR.

**Sole-maintainer caveat (assumption A4):** GitHub does not let an author approve their own PR.
The model is "the agent identity `hacker1dbai` authors and pushes; the owner reviews and approves".
That identity was not available to the agent that opened these PRs, so they are authored by
`hacker1db` and the owner can only merge them with the admin bypass. Until `hacker1dbai` exists
(a separate GitHub account with write access, used only by agents), every owner-authored PR needs
the bypass. If the owner pushes to an agent PR, the last-push rule blocks the owner's approval:
have the agent push a follow-up commit, or open a fresh agent-authored PR.
