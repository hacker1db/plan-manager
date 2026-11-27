# CI/CD plan: environment contract and gated release (record)

This file keeps the plan the work in `config/env.contract.json`, `.github/workflows/`, and
`docs/operations/ci-cd.md` implements, and the review evidence behind it. It is a record, not the
operator guide; for what to set up and how, read [`ci-cd.md`](ci-cd.md).

**Review status:** a three-model council (Opus, Sol, Mythos) reviewed this plan over three rounds
and did **not** pass it. The owner chose to proceed. The round-3 findings are therefore binding
amendments: where the plan text below and an amendment disagree, **the amendment wins**.

## Assumptions the owner has not yet confirmed

The implementation is built on these. Each is easy to change; where one matters, the code or the
operator guide says so.

1. **Vercel Hobby plan**: no team, no separate automation member, Instant Rollback only to the
   immediately previous production deployment.
2. **Vercel credential**: one personal Vercel token, stored only in GitHub environments whose
   deployment branch policy is `main`. Never in PR workflows.
3. **Two Vercel projects** (preview and production) are acceptable.
4. **No `hacker1dbai` identity was available** to the implementing agent, so PRs are opened as
   `hacker1db`. The plan's "agent authors, owner approves" model needs that second identity; until
   it exists the owner cannot approve their own PRs and must use the admin bypass (see `ci-cd.md`).

## Binding amendments (round 3)

1. Production isolation must not depend on anything a PR can edit. `git.deploymentEnabled` and
   `ignoreCommand` live in `vercel.json`, which Vercel reads from the PR commit. The trusted
   `release.yml` builds `main` itself and deploys it (`vercel build --prod`,
   `vercel deploy --prebuilt --prod --skip-domain`); disconnecting the production project from Git is
   an operator prerequisite. No deployment restrictions go in the shared `vercel.json` (both projects
   read it, and it would break preview builds).
2. Every trusted workflow that calls the Vercel API declares a Vercel token in its own GitHub
   environment (release, preview-smoke, env-audit). Bypass tokens cannot discover or promote
   deployments. PR jobs stay credential-free.
3. Rollback uses the supported rollback operation pinned to the recorded previous deployment ID,
   polls until the alias job finishes, then verifies the production domain serves the expected
   deployment. Fail fast when the build ends in `ERROR`. (Verified against Vercel docs on
   2026-11-26, recorded in `ci-cd.md`.)
4. The `env-provisioned` label is not a real gate (any write-access account can apply it). The gate
   accepts only an owner-created commit status on the PR head commit.
5. CODEOWNERS covers everything that can neuter a check: `* @hacker1db`, one required approval.
6. The watchdog starts its clock at release approval, not at push; superseded runs waiting for
   approval must not hold the release lock forever.
7. Reconcile duplicates rather than adding to them (see "Reconciliation" below).
8. The health-detail token is production-required in the contract (the server holds it).
9. Tests for: no non-main deployment in the production project (drift-audit assertion), auth on
   `/api/health/detail`, the contract-change gate script, and async alias-job handling in rollback.
   Generated-file order is deterministic so `contract:check` is stable. zizmor's `workflow_run`
   finding gets a reasoned ignore rather than dropping the trigger.

## Reconciliation with existing branches (amendment 7)

| Branch | State on 2026-11-26 | Decision |
| --- | --- | --- |
| `fix/vercel-production-env` | Merged as #103 (`scripts/hosted-env-keys.mjs`, `scripts/check-vercel-env.mjs`). | PR A deletes `hosted-env-keys.mjs` (it regex-parsed `REQUIRED_KEYS`) and makes `check-vercel-env.mjs` and the build guard read the contract. Kept: the names-only `vercel env ls` inventory check and its tests. |
| `ci/prevent-env-build-failures` | Merged as #104 (`.github/workflows/hosted-build.yml`, `scripts/ci-production-build.mjs`, `test/hosted/build-env.test.ts`). | Reused: the fixture production build and the guard regression tests (unchanged). PR B folds `hosted-build.yml` into `ci.yml`. Dropped: reading fixture keys from `.env.example` (now from the contract). |
| `chore/preview-branch-workflow` (issue #96, not merged) | Adds `scripts/promote.sh`, a second promotion path. | Superseded by `release.yml` as the only promotion writer. Not edited here; the owner should close that branch or rebase it without `promote.sh`. |

## Implementation notes and deviations

- No ajv dependency: `scripts/env-contract.mjs` validates the contract by hand, and a test keeps it
  in step with `config/env.contract.schema.json`.
- The build guard keeps today's checks exactly (non-empty, owner list, cookie length); the runtime
  keeps its stricter URL-shape checks. Adding URL checks to the build is a possible follow-up.
- `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` is added with the health endpoint (release PR), not in PR A,
  so PR A cannot break the next production build; the contract-change gate makes the owner
  provision it first.
- PR CI uses no caches at all (simpler than restore-only) and cancels superseded runs only for
  PRs, so every push to `main` reaches `release.yml`.
- No lint job: the repository has no lint script.
- Pandoc 3.13 (checksum-pinned) is installed in CI because the CLI contract suites need it.
- The release `workflow_dispatch` dry run was dropped: the fake-client release suite runs in every
  CI run, and a dry run cannot exercise real credentials or alias jobs either (Sol, round 3). The
  drift audit keeps its dry run.
- The Vercel CLI for releases is pinned in `ci/vercel-cli/package-lock.json` and installed with
  `npm ci`, so every package is integrity-checked.
- Preview smoke reports a commit status rather than a check run.

## Round-3 votes (verbatim summaries)

### Sol

RC3-dae8a7d-1: REJECTED 9.6
High: §4 relies on PR-editable `git.deploymentEnabled`/ignore configuration for production isolation; the project bypass is available at build/runtime. [Vercel](https://vercel.com/docs/environment-variables/system-environment-variables)
Fix: disconnect production Git integration; deploy only approved main SHAs through a privileged workflow.

RC3-dae8a7d-2: REJECTED 9.9
High: release/preview workflows lack Vercel API credentials; only `env-audit` receives a token. Bypass tokens cannot authenticate deployment discovery or promotion.
Fix: explicitly provision scoped credentials in each trusted environment; keep PR jobs credential-free.

RC3-dae8a7d-3: REJECTED 10.0
High: `vercel promote PREV` cannot restore an already-promoted deployment; rollback requires the rollback operation. Background alias jobs also require completion checks. [Vercel](https://vercel.com/docs/deployments/promoting-a-deployment)
Fix: ID-pinned rollback, poll terminal job status, then verify production domain and deployment identity.

RC3-dae8a7d-4: REJECTED 10.0
High: §9’s promote-as-rollback behavior contradicts documented platform behavior, regardless of Hobby/Pro.
Fix: use the supported rollback API/CLI; enforce Hobby’s immediate-predecessor restriction. [Vercel](https://vercel.com/docs/instant-rollback)

RC3-dae8a7d-5: CONFIRMED 9.5
Contract-driven consumers, generated documentation, drift checks, and SHA-pinned reusable workflows provide a coherent maintenance path.
Low: specify generated filenames and generation order so `contract:check` remains deterministic.

RC3-dae8a7d-6: REJECTED 9.8
High: fake-client tests explicitly expect the unsupported `promote PREV` sequence; fake-only dispatch cannot validate actual credentials, permissions, or platform transitions.
Fix: correct rollback expectations; add asynchronous alias-job tests and an isolated real-project deploy→promote→rollback acceptance test.

### Opus

RC3-dae8a7d-1: REJECTED 8.0
- High: §4 isolation depends on the production project skipping non-main builds. Both switches the plan names (`git.deploymentEnabled`, `ignoreCommand`) can live in `vercel.json`. Vercel reads that file from the PR commit and builds before anyone reviews, so CODEOWNERS on `vercel.json` does not help. A PR build in that project gets `VERCEL_AUTOMATION_BYPASS_SECRET`, which opens staged production deployments.
- Medium: the label gate is not real, because the agent has write access and can add `env-provisioned` itself. `package.json`, which holds the `build:web` and test scripts, is not owned in CODEOWNERS, so a PR can quietly turn checks into no-ops. The release token is never stated, and Vercel tokens cannot be read-only or limited to one project.
- Smallest fix: take the production project off Git entirely. Have `release.yml` build `main` and deploy it with `vercel build --prod` plus `vercel deploy --prebuilt --prod --skip-domain`. Add `package.json`, `scripts/**` and `test/**` to CODEOWNERS. Make the gate check a commit status set by the owner, not a label. Name the release token and where it is stored.

RC3-dae8a7d-2: REJECTED 7.0
- High: the plan never says how to turn off previews in the `plan-manager` project in a way PR code cannot override (same root cause as -1). `release.yml` also needs a Vercel token to run `promote`, but the `production` environment lists only the bypass token and the health-detail token.
- Low: `cancel-in-progress` on push to `main` skips the release for in-between commits. That is acceptable, but the watchdog needs to know about it.
- Fix: the trusted-deploy change from -1, and add `VERCEL_TOKEN` to the `production` environment.

RC3-dae8a7d-3: CONFIRMED 6.5
- Good: one promotion writer, rollback pinned to an exact ID, a stale guard, and fake-client tests that check every mutating call. All probes are read-only.
- Medium: Hobby Instant Rollback counts staged deployments as "previous", so "PREV is the immediate predecessor" may not hold. The watchdog alarms whenever the owner has not yet approved the release. Both are documentable.
- Fix: on Hobby, roll back with `promote PREV` by ID. Pause the watchdog while the release waits for approval.

RC3-dae8a7d-4: REJECTED 7.0
- High: on Hobby there are no teams or members. A "team-scoped token owned by a dedicated automation account" therefore cannot reach a personal Hobby project. The "disable previews" switch from -1 also does not exist as described.
- Fix: settle the Vercel plan (Pro is needed for an automation member). Otherwise accept a personal full-access token, kept in the env-audit and production environments with branch policy `main`, and document that risk.

RC3-dae8a7d-5: CONFIRMED 7.5
- One JSON contract, validated by schema, with codegen for `env.ts`, `src/env.ts`, the guard, `.env.example` and the docs, plus a `contract:check` drift failure. That replaces the regex and duplicated keys in `scripts/check-hosted-env.mjs`.
- The reusable `workflow_call` extraction is scoped, and the pilot switches over in the same PR.

RC3-dae8a7d-6: CONFIRMED 7.0
- Negative guard tests cover each missing var, invalid values, no value leaks, and guard == runtime == contract. There is a full fixture `VERCEL_ENV=production` `pnpm build`, an empty-env build that must fail, and fake-client orchestration suites.
- Low: zizmor will flag `workflow_run`, so the plan needs a reasoned ignore. Fixture builds cannot prove real Vercel config; only the drift audit does, and the plan says so.

### Mythos

RC3-dae8a7d-1: REJECTED 8.0
High: §4 isolation can be switched off by the PR itself. Vercel docs confirm `ignoreCommand` in `vercel.json` overrides the project's Ignored Build Step, and `git.deploymentEnabled` lives in that same file. A pushed branch can therefore make project `plan-manager` build it and receive `VERCEL_AUTOMATION_BYPASS_SECRET` (build and runtime) before any CODEOWNERS review; I could not confirm a dashboard-only "previews disabled" switch.
Medium: `env-provisioned` is not maintainer-only (the write-access `hacker1dbai` can label), and CODEOWNERS omits `package.json` and `src/**` with no approval count stated.
Fix: disconnect Git from the production project and create the deployment from `release.yml` with `vercel deploy --prod --skip-domain`; add `* @owner` with one required approval; check the label actor.

RC3-dae8a7d-2: REJECTED 7.5
High (combined): both projects read the same root `vercel.json`, so restricting `git.deploymentEnabled` to main also stops PR builds in `plan-manager-preview`. That project's own main build runs with `VERCEL_ENV=production`, so `scripts/check-hosted-env.mjs` fails it on every merge.
High: `release.yml` steps 1, 2 and 5 and the `preview-smoke.yml` lookup need a Vercel token, but the `production` environment lists only the bypass and detail tokens, and preview-smoke names no environment.
Fix: use per-project dashboard settings only, set the preview project's production branch to an unused branch, and declare a project-scoped token per workflow. Low: unmerged `chore/preview-branch-workflow` adds `scripts/promote.sh`, a second promotion path the plan does not reconcile.

RC3-dae8a7d-3: CONFIRMED 7.0
Ready: the concurrency group, the stale guard (main HEAD and PREV), ID-pinned rollback with a re-check, and read-only probes cover the races. Docs confirm promote and rollback by ID, and the Hobby limit to the immediate predecessor that §9 handles.
Medium: the 60-minute watchdog will false-alarm against the required-reviewer gate, and stale runs awaiting approval hold `release-prod` until approved or rejected. Low: step 1 should fail fast on an ERROR build.
Fix: start the watchdog clock at approval and auto-reject superseded runs.

RC3-dae8a7d-4: CONFIRMED 6.5
Ready: docs confirm `POST /v10/projects/{id}/promote/{deploymentId}`, the rollback endpoint, `--skip-domain` with the auto-assign setting, per-project bypass, the env API, and project-scoped tokens. The GitHub Free public-repo features are from my own knowledge, not checked here.
Medium: a "dedicated automation account" is not possible if the team is Hobby (single member, as far as I know), and "maintainer-only label" is not a GitHub feature.
Fix: use an owner-issued project-scoped token and verify the label actor.

RC3-dae8a7d-5: CONFIRMED 7.5
Ready: the JSON contract replaces the regex parse and the duplicated `CLI_KEYS` and cookie length in `scripts/check-hosted-env.mjs`, generated docs are drift-checked, and the `workflow_call` extraction path is defined.
Medium: `fix/vercel-production-env` adds `scripts/hosted-env-keys.mjs` and `scripts/check-vercel-env.mjs`, a second key source the plan does not say PR A supersedes. The health-detail token is declared `requiredIn []`, yet the server must hold it in Vercel production.
Fix: PR A deletes or derives those files, and the detail token is marked production-required.

RC3-dae8a7d-6: CONFIRMED 7.5
Ready: negative tests spawn the guard per variable, the fixture build runs the full `pnpm build` with `VERCEL_ENV=production`, fake-client suites assert exact mutation sequences, and there is a dry run plus actionlint and zizmor.
Medium: nothing tests the isolation invariant (no non-main deployments in `plan-manager`), the `/api/health/detail` auth, or the contract-change gate script.
Fix: add a drift-audit assertion and two unit suites.

## Plan v3 (base text)

Earlier versions (v1, v2) were superseded by v3 and are not kept here.


v3 changes (council round 2, Opus + Sol): bypass/credential isolation by separate Vercel projects; reviewer model for a
sole maintainer (agent authors, owner approves); single promotion writer with ID-pinned rollback; per-target storage
rules; fork guards; mocked end-to-end orchestration tests. Prior versions: plan-v1.md, plan-v2.md.

Repo: hacker1db/plan-manager (public, user-owned, single human maintainer; agent identity hacker1dbai opens PRs).
Hosting: Vercel Git integration, SvelteKit. Today: no .github/workflows. vercel.json: `pnpm install --frozen-lockfile`,
`pnpm build` (check-hosted-env.mjs when VERCEL_ENV=production → sync style → vite build → check-client-bundle.mjs).
REQUIRED_KEYS regex-parsed from src/lib/server/env.ts; CLI_KEYS/cookie length duplicated; src/env.ts declares SvelteKit env.
Incident: PR #99/#101 production builds failed closed at the guard (missing WORKOS_API_KEY,
PLAN_MANAGER_OWNER_WORKOS_USER_IDS, PLAN_MANAGER_WORKOS_CLI_CLIENT_ID, PLAN_MANAGER_WORKOS_CLI_AUDIENCE).
Gap: nothing detects missing production config before merge, and nothing gates promotion.

### 0. Hard limits
Agents never merge, change live Vercel/GitHub settings or rulesets, or provision secrets. Those are operator
prerequisites (docs/operations/ci-cd.md). Remediation stays on fix/vercel-production-env; preliminary prevention work on
ci/prevent-env-build-failures is reconciled (reused or closed with pointer), never duplicated.

### 1. Environment contract (single source)
- `config/env.contract.json`, validated by `config/env.contract.schema.json` (ajv unit test).
  Per var: name; requiredIn[production|preview|development]; sensitivity secret|config|public; exposure server|client;
  validator id (nonEmpty, minLength:32, csvNonEmpty, url, pattern); CI fixture (obviously fake, cannot validate at a
  provider); storage per target: production+preview secret → `sensitive`; development → `encrypted` (Vercel does not
  offer sensitive for development); config → `encrypted` or `plain`; owner; docs anchor.
- Consumers: src/lib/server/env.ts and src/env.ts import it (typed via `satisfies` + small codegen); guard reads JSON
  (regex removed; CLI_KEYS/cookie length derived). Generated: .env.example, docs/hosting.md table. `contract:check` fails on drift.
- check-client-bundle.mjs keeps its existing non-env needles and adds every contract secret name and fixture value.
- Release-only secrets (bypass token, health-detail token) are contract entries with requiredIn [] and target
  "github-environment", so they are documented and drift-checked by name.

### 2. Review and workflow-trust model (closes check spoofing, works for one maintainer)
- PRs are authored and pushed by the agent identity hacker1dbai; the human owner is the code owner and approver.
  Because the approver never authors or pushes, "require code-owner review" + "require approval of most recent push"
  + "dismiss stale approvals" do not deadlock. If the owner pushes to a PR, the documented path is: hacker1dbai pushes
  a no-op-free follow-up or the owner opens a fresh agent-authored PR; admin bypass is reserved for incidents and every
  bypass is logged (ruleset bypass audit) and listed in a weekly drift issue.
- `.github/CODEOWNERS`: `.github/**`, `scripts/ci/**`, `scripts/check-*.mjs`, `config/env.contract*.json`, `vercel.json`
  → owner. Ruleset (operator): require PR, code-owner review, last-push approval, required check `ci-required` from the
  GitHub Actions app, block force push/deletion, bypass = repository admin only. A PR that fakes `ci-required` by editing
  workflows cannot merge without the owner reviewing that diff. AI reviews never count as approval.

### 3. Untrusted PR CI (`.github/workflows/ci.yml`)
- `pull_request` [opened, synchronize, reopened, labeled, unlabeled] and `push` to main. `permissions: contents: read`;
  no secrets, no id-token, no pull_request_target; actions pinned by SHA; `persist-credentials: false`; cache restore-only
  on PRs; `concurrency: ci-${{ github.ref }}` cancel-in-progress.
- Jobs: frozen-lockfile install (corepack pnpm per packageManager), contract:check, lint, typecheck (web, go vet),
  unit+integration tests (cli, lib, web, test:contracts) with fake adapters, no network to WorkOS/Neon/Blob;
  production-equivalent build `VERCEL_ENV=production` with fixtures from scripts/ci/env-fixtures.mjs, full `pnpm build`.
- Negative tests (node:test spawning the guard): each required var missing → exit 1 naming it; invalid values → exit 1;
  output never contains any fixture value; non-production → exit 0; guard set == runtime set == contract set.
- Contract-change gate: compares PR contract to origin/main; adding a production-required var or changing a validator
  fails the job (plain failure, explicit message) unless label `env-provisioned` is present (maintainer-only label;
  applied by the owner after provisioning, verified post-merge by the drift audit). Gate script is CODEOWNERS-protected.
- `ci-required` aggregate (`needs` all, `if: always()`, fails unless all succeeded).

### 4. Credential isolation: two Vercel projects
- Project `plan-manager-preview` (Git-connected, builds all PR branches, own Preview env vars with preview-only WorkOS
  test tenant/staging DB/Blob store, own protection-bypass secret). Project `plan-manager` (production): Git integration
  set to deploy only `main` (ignored build step for non-main, `git.deploymentEnabled` restricted to main), Preview
  deployments disabled, so no PR-controlled code ever runs inside the production project or can receive its bypass.
- Because Vercel bypass secrets are per project, the production bypass secret only authorizes deployments built from
  main. The preview bypass secret is treated as exposed to PR code: it grants access only to preview deployments that
  hold no production data or credentials.
- Operator prerequisites: create preview project, move preview env vars, disable previews on production project.

### 5. Trusted metadata drift audit (`env-drift.yml`)
- Triggers: schedule daily, workflow_dispatch (dry_run → recorded JSON), push to main. Checks out main only.
  Environment `env-audit` (branch policy main only) holds a Vercel token; token is the only Vercel credential in that
  environment, team-scoped, owned by a dedicated automation account, rotated 90 days (operator).
- `GET /v10/projects/{id}/env` (no decrypt) for both projects. Script retains key/target/type, deletes `value` from each
  object before any other processing, never logs bodies. Fails on: required var absent for a target; storage type below
  the contract's per-target minimum; secret present in a target where it must not be (e.g. production secret in preview project).
- Watchdog: alert if main HEAD not promoted within 60 min. Failures → dedup GitHub issue, updated not recreated.

### 6. Preview smoke (`preview-smoke.yml`)
- Trigger `workflow_run` of ci.yml (default-branch definition). `if: github.event.workflow_run.head_repository.full_name
  == github.repository` (fork PRs skipped). Never checks out PR code. Resolves deployment in plan-manager-preview by
  meta.githubCommitSha == head_sha (client-side filter), verifies project id and URL suffix, then GETs /api/health and an
  auth route expecting 401/redirect with the preview bypass. Advisory check via `checks: write`.

### 7. Staged production release (`release.yml`) — sole promotion writer
- Operator: on project plan-manager disable auto-assign of custom production domains; document that dashboard/CLI
  promotions and rollbacks are not used during normal operation (only release.yml promotes; manual action = incident,
  must first cancel/await release-prod).
- Trigger: `workflow_run` of ci.yml with `if: event=='push' && head_branch=='main' && head_repository==repository &&
  conclusion=='success'`. Environment `production` (required reviewer owner, branch policy main) holds the production
  bypass secret and health-detail token. `concurrency: release-prod`, cancel-in-progress false.
- Steps:
  1. Find production deployment with meta.githubCommitSha == head_sha (poll ≤20 min, else fail + alert).
  2. Record PREV = current promoted deployment ID.
  3. Pre-promotion read-only tests on the staged URL: /api/health (public status only); /api/health/detail (requires
     bypass + detail token; per-dependency booleans: Neon `select 1`, Blob HEAD known key, WorkOS authenticated
     read-only list call proving WORKOS_API_KEY, CLI audience JWKS); unauthenticated → 401/redirect. Never values.
  4. Stale guard immediately before promote: main HEAD == head_sha AND current promoted ID == PREV; else abort (newer
     release or external promotion happened).
  5. `vercel promote <id>`; post-promote smoke on the production domain.
  6. On smoke failure: re-check current promoted ID == our id (else do nothing and alert: someone else promoted), then
     `vercel promote PREV` (explicit ID, not "previous") and alert. Rollback failure → alert critical with runbook.
- Value/auth validation happens only here, never in PR CI. All probes non-destructive.

### 8. Alerts
Drift, release, rollback, watchdog, ruleset-bypass failures → dedup GitHub issue + Actions failure email; optional
Vercel deployment-failed notifications (operator).

### 9. Plan support
GitHub Free public repo: rulesets, CODEOWNERS required review, last-push approval, environments with reviewers and branch
policies, workflow_run. Vercel Hobby/Pro: multiple projects, disable domain auto-assign, `vercel promote <deployment>`
(also used to promote an older deployment for rollback), protection bypass for automation (per project), env API,
sensitive vars for production/preview. Rolling Releases not used. If the account is Hobby and promote-by-ID of an older
deployment is restricted, rollback uses Instant Rollback to PREV after verifying PREV is the immediate predecessor (step 2
guarantees it under the single-writer rule); documented.

### 10. Testing the orchestration
- Release logic in `scripts/ci/release.mjs` with an injected Vercel/GitHub client; node:test suites with a fake client:
  happy path; deployment never appears; pre-promotion probe fail (no mutation); stale head; external promotion between
  steps 2 and 4 (abort, zero mutations); post-promote smoke fail → promote PREV with exact ID; rollback when someone else
  promoted meanwhile (no mutation); rollback API failure (critical alert). Each asserts the exact sequence of mutating calls.
- Preview smoke and drift: fake-client tests incl. fork event skip, wrong project/URL rejected, malicious preview body
  ignored (status-only parsing), plain-type value present → stripped and flagged.
- workflow_dispatch `dry_run` for release (fake client, real workflow wiring); actionlint + zizmor in CI.

### 11. Reusable architecture (post-pilot)
After 2 green weeks extract ci/drift/release into SHA-pinned reusable `workflow_call` workflows in a shared repo with
the contract schema versioned; pilot switches to callers in the same PR and deletes old files.

### 12. Delivery (each 🌳, issue-referenced, agent-authored, owner-approved)
A contract+consumers+generated docs+negative tests; B CODEOWNERS+ci.yml+prod-equivalent build+bundle scan+gate+ci-required;
C env-drift+watchdog+alerts; D release.mjs+release.yml+preview-smoke+/api/health(+detail)+runbook+orchestration tests.

### 13. Verification
`pnpm install --frozen-lockfile && pnpm contract:check && pnpm typecheck && pnpm test`; fixture production build passes;
empty-env production build fails naming vars; orchestration fake-client suites; actionlint + zizmor.
