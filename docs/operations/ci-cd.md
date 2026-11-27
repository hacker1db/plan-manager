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
| `git-connected` | The production project is still connected to Git, so PR branches could build inside it. | Disconnect it (cut-over step 7). |
| `non-main-deployment` | A production-project deployment created after `PRODUCTION_ISOLATION_SINCE` was not made by `release.yml` from `main`. | Investigate as an incident: who deployed, and with which code. |

A failure opens (or updates) one issue titled **Alert: Vercel configuration drift**; the next
passing run comments and closes it. Run **Actions → env-drift → Run workflow** with **dry_run**
ticked to exercise the same code against `test/fixtures/vercel-drift-recording.json` without a
token.

Only an unscoped record for exactly that target counts: a variable scoped to one Git branch
(`gitBranch`), a custom environment, or a record with no target does not satisfy Production.
Problems are listed with `missing` first, and at most 20 historical deployments are listed, so a
missing variable is never buried.

Limits: the audit proves names and storage types, never values. A name set to a blank value, or a
cookie password shorter than 32 characters, passes the audit; the production build guard
(`scripts/check-hosted-env.mjs`) remains the last line of defence and still fails such a build. GitHub environment secrets cannot
be listed by the workflow token, so a missing `VERCEL_TOKEN` shows up as a failed run instead.
Deployment metadata is written by whoever deploys, so the audit checks it against GitHub: the
named run must be a `release.yml` run on `main` for exactly that commit, the commit must be on
`main`, and the deployment must have been created while the run was going. Every page of
deployments is read, and a deployment with no creation time is flagged. Someone holding the token
could still deploy by hand during a real release run with copied metadata; the token is the final
boundary.

### Interim gap until the release cut-over

Until the production project is disconnected from Git (cut-over step 7), **Vercel deploys every
merge to `main` straight to production**, in parallel with this audit. The audit detects drift
but cannot stop that deploy, and the contract-change gate fires only when the contract changes.
A merge that changes no requirement can therefore still fail its production build on drift that
already exists (that is what happened with #104). Until cut-over:

1. Before every merge to `main`, run `pnpm check:vercel-env` (names only) against the production
   project and merge only when Production reports every name.
2. Keep Vercel failed-deployment notifications on. A failed build leaves the previous deployment
   serving; fix the variable and redeploy.

After cut-over the release workflow's preflight job blocks the deploy itself (see "Release").
First live check after the owner sets up `env-audit`: run **Actions → env-drift → Run workflow**
(not dry run). Expected today: `missing` `PLAN_MANAGER_OWNER_WORKOS_USER_IDS` in Production,
plus `git-connected` and historical `non-main-deployment` rows.

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
| `production-release` | `main` only | `hacker1db` | `VERCEL_TOKEN`, `VERCEL_PROTECTION_BYPASS_PRODUCTION`, `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_PRODUCTION`, `PRODUCTION_DOMAIN` (`planmanager.hacker1db.dev`), `VERCEL_TEAM_ID` (only if a team) |
| `preview-smoke` | `main` only | none | `VERCEL_TOKEN`, `VERCEL_PROTECTION_BYPASS_PREVIEW` | `VERCEL_PROJECT_ID_PREVIEW`, `VERCEL_TEAM_ID` (only if a team) |

The repository already has GitHub environments named `Preview` and `Production` that the Vercel
Git integration created for its deployment statuses. The release uses a separate environment,
`production-release`, so its reviewer and branch rules cannot interfere with those.

## Health endpoints

| Endpoint | Auth | Answers |
| --- | --- | --- |
| `GET /api/health` | none | `{"status":"ok"}` (200) or `{"status":"unconfigured"}` (503). No dependency detail. |
| `GET /api/health/detail` | `Authorization: Bearer <PLAN_MANAGER_HEALTH_DETAIL_TOKEN>` | `{"status":"ok"\|"degraded","checks":{"database","blob","workos","cliJwks"}}`, booleans only; 503 when any check fails. 401 without the right token. 503 when the token is not configured, so it never runs unauthenticated. |

The checks are read-only: Neon `select 1`, a one-item Blob `list`, an authenticated WorkOS
`GET /user_management/users?limit=1` (proves `WORKOS_API_KEY`), and the CLI AuthKit JWKS. Each
has a 5-second timeout; error text never leaves the server. `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` is
production-required in the contract (amendment 8): the production build fails without it, and the
same value lives in the `production-release` GitHub environment for the release checks. Generate it with
`openssl rand -base64 48` and paste it into both places; never into a ticket or chat.

## Release (`release.yml`)

`release.yml` is the only thing that deploys or promotes production. It starts when `ci` passes
for a push to `main`:

1. **Cancel superseded releases** (no secrets): cancels older release runs that are still
   waiting for approval, so they cannot hold the release lock.
   **Production env preflight** (environment `env-audit`, before you are asked to approve):
   checks, by name only, that the production project's Production target has every variable
   the contract of the commit being released requires. It fails closed on a missing name, an API
   error, or a missing token, and the release job depends on it, so nothing is built or deployed.
   This closes the #104 failure class without relying on the `env-provisioned` attestation. The
   release job repeats the check right after approval.
2. **release** waits for your approval in the `production-release` environment. Approve it under the
   run's **Review deployments**. Only one release runs at a time (`release-prod`).
3. It builds that exact `main` commit with the production project's settings (`vercel pull`,
   `vercel build --prod`; the build guard fails closed), and deploys it **staged** with
   `vercel deploy --prebuilt --prod --skip-domain`, tagged with the commit and run ID.
4. `scripts/ci/release.mjs` then:
   - stops without changes if `main` has moved on;
   - waits for the deployment to be READY, failing fast on ERROR;
   - records **PREV**, the deployment production serves now;
   - checks the staged URL: `/api/health`, `/api/health/detail` (all true), and that
     `/api/health/detail` and `/api/v1/plans` refuse anonymous requests;
   - checks again that `main` has not moved and production still serves PREV, then promotes;
   - waits for Vercel's asynchronous alias job, checks that the domain serves the new deployment,
     and runs the health checks against the domain;
   - if anything after the promote fails and production serves the new deployment, rolls back
     to PREV **by ID** with the rollback API, waits for that alias job, and checks the domain
     serves PREV again. If someone else changed production meanwhile, it does not touch it.
5. Failures open **Alert: production release failed**; a failed rollback opens
   **CRITICAL: production rollback failed**. A successful release closes the release alert.

During normal operation, do not promote or roll back from the Vercel dashboard or CLI. A manual
action is an incident: first cancel or let finish any running `release` run (Actions →
release), then follow "Manual rollback".

### Verified platform facts (2026-11-26)

Checked against Vercel's documentation and the installed CLI (54.9.1) `--help`:

- `vercel rollback <id|url>` and `POST /v1/projects/{projectId}/rollback/{deploymentId}` point
  production at a previous production deployment. **On Hobby only the immediately previous
  production deployment is allowed** ("To rollback further than the previous production
  deployment, upgrade to pro"). PREV is that deployment, because release.yml is the only writer.
- Rollback is asynchronous: Vercel's `deployment.rollback` webhook notes acceptance can arrive
  before traffic switches. Hence the polling and the domain check.
- `vercel promote <id>` / `POST /v10/projects/{projectId}/promote/{deploymentId}` promote without
  rebuilding (201 or 202). Vercel documents `vercel promote` as the way to **undo a rollback**,
  which also re-enables automatic domain assignment. The docs do not settle whether promoting an
  older, already-promoted deployment restores it, so the release uses the rollback operation to
  restore PREV, as amendment 3 requires.
- `vercel deploy --prebuilt --prod --skip-domain` creates a production deployment without
  assigning domains.

Not verified (exercised only with fake clients): the project fields `targets.production.id` and
`lastAliasRequest.{toDeploymentId,jobStatus}` used to observe alias-job completion, and
`GET /v13/deployments/{domain}` resolving the domain to its deployment. If the first real
release times out waiting for the alias job, these are the first thing to check.

### Manual rollback (incident)

1. Actions → release: cancel any run that is waiting or running.
2. Find the deployment to restore: `vercel list plan-manager --prod` (Hobby: only the previous
   production deployment can be restored).
3. `vercel rollback <deployment-id> --scope <your-scope>` then `vercel rollback status`.
4. Check `https://planmanager.hacker1db.dev/api/health` returns `{"status":"ok"}`.
5. After a rollback Vercel stops auto-assigning production domains until a promote. The next
   successful `release.yml` run promotes and so restores normal operation. Do not promote by hand.
6. Write what happened on the alert issue, then close it.

## Preview smoke (`preview-smoke.yml`)

After `ci` finishes for a same-repository PR, finds the preview project's deployment for the PR
head commit, checks it is in the preview project and on a `*.vercel.app` URL, then checks
`/api/health` is ok and `/api/v1/plans` refuses an anonymous request, using the preview project's
bypass secret. Reports the advisory `preview-smoke` commit status. Fork PRs are skipped. It never
checks out PR code and reads only status codes and the health status string. The preview bypass
secret is treated as exposed to PR code: it opens only preview deployments, which hold no
production data or credentials.

## Cut-over order

Do these in order. Steps marked **(PR)** are merges; the rest are operator settings.

1. **(PR)** Merge #106 (contract). No new variables; production deploys as before.
2. Ruleset: add the required check `ci-required` (source GitHub Actions) and code-owner review
   (see "Operator prerequisites (PR CI)"). **(PR)** Merge #107.
3. Create the preview project, the Vercel token and the `env-audit` environment ("Operator
   prerequisites (drift audit)"). Set `env-provisioned` on #108's head commit. **(PR)** Merge
   #108. The audit will report `git-connected` and `non-main-deployment` until step 7; expected.
4. In the **production** project (`plan-manager`):
   - add `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` (Production, **Sensitive**);
   - Settings → Deployment Protection → **Protection Bypass for Automation**: create a secret;
   - Settings → Environments → Production: turn **off** "Auto-assign Custom Production Domains"
     (from now on Git-built production deployments are staged only; nothing goes live without
     `release.yml`).
   In the **preview** project, create its Protection Bypass for Automation secret too.
5. Configure the `production-release` and `preview-smoke` GitHub environments as in the table above.
   Set `env-provisioned` on the release PR's head commit. **(PR)** Merge the release PR.
6. Approve the first `release` run and watch it to the end. Confirm the domain serves the new
   deployment.
7. In the production project: Settings → Git → **Disconnect** the repository. Set the `env-audit`
   variable `PRODUCTION_ISOLATION_SINCE` to the current time in ISO format
   (for example `2026-12-01T18:00:00Z`). Run env-drift by hand and confirm it passes.
8. Ruleset: change "Require deployments to succeed" from `Preview` to the preview project's
   deployment environment as it appears on a PR (for example `Preview – plan-manager-preview`).
9. Close or rebase `chore/preview-branch-workflow` (#96) without `scripts/promote.sh`, so there
   is only one promotion path.
10. Optional acceptance test (recommended by the council, not automated here): in a throwaway
   Vercel project, run deploy → promote → rollback once by hand with the same CLI version to see
   the real alias-job fields.

## Complete operator prerequisite list

| # | Where | What | Needed before |
| --- | --- | --- | --- |
| 1 | GitHub ruleset `main` | Required status check `ci-required`, source GitHub Actions | merging #107 |
| 2 | GitHub ruleset `main` | Require review from Code Owners (keep 1 approval, last-push approval, dismiss stale) | merging #107 |
| 3 | GitHub | `hacker1dbai` agent account with write access, so the owner can approve agent PRs without bypass | any time (A4) |
| 4 | Vercel | Preview project `plan-manager-preview`, production branch set to an unused branch, Preview/Development variables only | merging #108 |
| 5 | Vercel | Personal token, 90-day expiry, calendar reminder to rotate | merging #108 |
| 6 | GitHub | Environment `env-audit` (main only) with its secret and variables | merging #108 |
| 7 | Vercel production project | `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` (Production, Sensitive) | merging the release PR |
| 8 | Vercel both projects | Protection Bypass for Automation secrets | merging the release PR |
| 9 | Vercel production project | Auto-assign Custom Production Domains **off** | merging the release PR |
| 10 | GitHub | Environment `production-release`: reviewer `hacker1db`, main only, secrets and variables | merging the release PR |
| 11 | GitHub | Environment `preview-smoke`: main only, secrets and variables | merging the release PR |
| 12 | Vercel production project | Disconnect Git; set `PRODUCTION_ISOLATION_SINCE` | after the first good release |
| 13 | GitHub ruleset `main` | Required deployment environment → the preview project's | after step 12 |
| 14 | Vercel | Secrets to Sensitive in Production and Preview (drift audit enforces it) | when the audit reports it |
| 15 | GitHub/Vercel | Failed-workflow and failed-deployment notifications | any time |
| 16 | GitHub | Close or rebase #96's `chore/preview-branch-workflow` without `scripts/promote.sh` | after the release PR |
