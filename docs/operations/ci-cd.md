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

## Drift audit (`env-drift.yml`, job "Drift audit")

Runs from `main` only: daily, on every push to `main`, and on demand. It never checks out PR code
and installs no dependencies. It reads the variable list of both Vercel projects **without
decrypting** (only name, target and storage type are kept; any value field is dropped first) and
fails when:

| Check | Meaning | Fix |
| --- | --- | --- |
| `missing` | A contract variable is absent for a target. Production is checked in the production project; Preview and Development in the preview project. | Add it in Vercel with the real value. |
| `storage-type` | The type is weaker than the contract minimum (secrets must be **Sensitive** in Production and Preview, **Encrypted** in Development). | Remove and re-add it with `--sensitive`. |
| `preview-production-target` | The preview project holds a Production-target variable. Its production target must stay empty so an accidental production build there fails closed. | Remove the Production target from that variable in the preview project. |
| `git-connected` | The production project is still connected to Git, so PR branches could build inside it. | Disconnect it (cut-over step 6). |
| `non-main-deployment` | A production-project deployment created after `PRODUCTION_ISOLATION_SINCE` was not made by `release.yml` from `main`. | Investigate as an incident: who deployed, and with which code. |

A failure opens (or updates) one issue titled **Alert: Vercel configuration drift**; the next
passing run comments and closes it. Run **Actions → env-drift → Run workflow** with **dry_run**
ticked to exercise the same code against `test/fixtures/vercel-drift-recording.json` without a
token.

Limits: the audit proves names and storage types, never values. GitHub environment secrets cannot
be listed by the workflow token, so a missing `VERCEL_TOKEN` shows up as a failed run instead.
A deployment that someone with the token creates by hand with forged metadata would pass the
`non-main-deployment` check; the token is the boundary.

## Release watchdog (`env-drift.yml`, job "Release watchdog")

Runs every 30 minutes with a read-only token. The clock starts when the owner **approves** the
release (the gated `release` job starts), so a release waiting for approval never alarms. It
alerts (issue **Alert: production release watchdog**) when: a release was approved more than 60
minutes ago and has not finished; the release for `main` failed or was cancelled; CI passed on
`main` more than 30 minutes ago and no release run started; or a release run for an older commit
is still waiting for approval (it holds the release lock: reject it under the run's
**Review deployments**). Until `release.yml` is on `main` the watchdog reports "nothing to watch".

## GitHub environments

| Environment | Deployment branches | Required reviewers | Secrets | Variables |
| --- | --- | --- | --- | --- |
| `env-audit` | `main` only | none | `VERCEL_TOKEN` | `VERCEL_PROJECT_ID_PRODUCTION`, `VERCEL_PROJECT_ID_PREVIEW`, `PRODUCTION_ISOLATION_SINCE`, `VERCEL_TEAM_ID` (only if the projects are in a team) |

The contract lists these names (`store: github-environment`), so adding one trips the
contract-change gate.

### Operator prerequisites (drift audit)

1. **Preview project.** Create a Vercel project `plan-manager-preview` from this GitHub
   repository (same root, framework and commands; `vercel.json` is shared and needs no change).
   In its Settings → Environments → Production, set the production branch to a branch that will
   never exist (for example `vercel-preview-project-unused`), so pushes to `main` do not build a
   production deployment there. Add Preview and Development variables from the contract table in
   `docs/hosting.md`, using preview-only resources (a WorkOS staging environment, a separate
   database branch, a separate Blob store). Add **no** Production-target variables.
2. **Vercel token (assumption A2).** In Vercel → Account Settings → Tokens, create a token named
   `plan-manager-github-actions` with a 90-day expiry. On Hobby a token cannot be limited to one
   project; it can act on every project in your account, which is why it lives only in
   `main`-only environments. Put a calendar reminder to rotate it.
3. **Environment `env-audit`.** GitHub → Settings → Environments → New environment `env-audit`.
   Deployment branches and tags: **Selected branches**, add `main`. No reviewers. Add the secret
   `VERCEL_TOKEN` and the variables in the table above. Project IDs are in each Vercel project's
   Settings → General. Leave `PRODUCTION_ISOLATION_SINCE` unset until cut-over step 6.
4. **Notifications.** GitHub → Settings → Notifications → Actions: notify on failed workflows
   only. Alert issues also notify you as the repository owner.
