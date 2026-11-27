# Hosted Plan Manager

The SvelteKit application in `src/routes` serves the private plan library at `https://planmanager.hacker1db.dev`. The CLI, local server, and hosted app share the root pnpm package and `src/` source tree. Canonical local Markdown remains in `~/notes/SecondBrain/4.Resources/plans`; uploads are explicit.

## GitHub and Vercel

Push the complete plan-manager repository to GitHub, then connect that repository to the existing `hacker1dbs-projects/plan-manager` Vercel project. Keep the existing project so its domain, integrations, and environment variables are preserved.

Set the existing Vercel project's root directory to the repository root (`.`). Use the SvelteKit framework preset, `pnpm install --frozen-lockfile` as the install command, and `pnpm build` as the build command. `@sveltejs/adapter-vercel` produces output for the explicitly selected `nodejs24.x` runtime. Select the desired production branch after it exists on GitHub. The build creates the CLI output and then builds the SvelteKit app from `src/routes`.

Commit application source, migrations, tests, `pnpm-lock.yaml`, and `.env.example`. Local `.env*` secrets, `.vercel/`, `.svelte-kit/`, `node_modules/`, and TypeScript caches are ignored. Never commit credentials or deployment-protection bypass tokens. The local `.vercel/` directory only identifies the linked project; it is not a Git backup.

The canonical browser UI lives in `src/dashboard/`. Hosted library and detail pages package the same HTML shells and JavaScript used by the local server, and generate their stylesheet, scripts, and favicon from that directory before web development and builds. Hosted APIs adapt authenticated cloud data to the browser contract; local filesystem and editor actions remain local-only. Do not maintain a second hosted dashboard implementation or a separate app package.

The stable SvelteKit 3 toolchain requires Node.js 22.17 or newer. Vercel runs the Node.js 22 runtime (`nodejs22.x` in `vite.config.ts`); keep local development compatible.

## Local development

From the repository root, run:

```sh
pnpm install --frozen-lockfile
vercel link --scope hacker1dbs-projects --project plan-manager
vercel env pull .env.local
pnpm typecheck
pnpm test
pnpm dev:web
```

All required keys in `.env.example` must be configured at runtime. Keep template values empty and never copy live values into documentation. The official SvelteKit AuthKit SDK requires the server-only `WORKOS_API_KEY`; it must never use a public prefix or enter a client bundle. The owner allowlist and token pepper must also be configured with Neon and private Blob variables. Environment pulls can overwrite an existing local file; preserve local-only values before pulling.

After linking and verifying environment configuration, apply the database schema with `pnpm db:migrate`. It loads root `.env.local` and applies every `src/lib/server/migrations/*.sql` file in order, each in an idempotent transaction. Migration `002_token_last_used.sql` adds the `last_used_at` and `created_at` token columns; apply it before relying on the token listing (token use keeps working without it). Run migrations intentionally rather than as part of every deployment.

## Access and uploads

WorkOS AuthKit authenticates browser sessions; only IDs listed in `PLAN_MANAGER_OWNER_WORKOS_USER_IDS` may view or manage plans. Set it to a comma-separated allowlist of WorkOS user IDs. There is no Clerk-variable fallback. Keep public sign-up disabled and invite only approved accounts. In the WorkOS Dashboard, set Hosted AuthKit MFA to **Required**; application code cannot prove or enforce that provider policy. WorkOS documents that this built-in MFA does not apply to SSO users, so Plan Manager owners must either be prevented from using SSO or covered by separately verified MFA at the SSO identity provider. Authentication success without allowlist membership returns 403.

Every browser API checks owner authorization. Uploads require scoped, expiring, revocable CLI tokens with salted server-side hashes. Markdown uses private Vercel Blob access; API responses exclude storage locators. Hosted pages render Markdown safely and refresh when uploaded revisions change. Filesystem actions and task editing remain available in the local dashboard.

```sh
plan auth login
plan push --all
```

Create a public WorkOS Connect application named `Plan Manager CLI` with CLI Auth enabled. Assign `openid`, `offline_access`, and `plans:write`. The CLI uses the device authorization and token endpoints on the configured AuthKit domain; it does not open a localhost callback or carry a client secret. `GET /api/v1` exposes only versioned, nonsecret client configuration. The API accepts a CLI access token only after RS256 signature, exact issuer, audience, client ID, `plans:write` scope, and owner-subject checks.

The CLI targets `https://planmanager.hacker1db.dev` by default; set `PLAN_MANAGER_URL` to use another deployment. `plan auth login` prints a user code and WorkOS verification URL, then stores the returned access and rotating refresh pair in macOS Keychain. `plan auth logout` removes the local credential; revoke the WorkOS grant separately when provider-side invalidation is required. Version-1 Clerk records require a new login.

Existing `pm_...` Plan Manager tokens remain an explicit compatibility bridge. They are scoped (`plans:write` only), expiring, revocable, and hashed at rest, but they are bearer credentials with no WorkOS session or TOTP binding: a `pm_` token bypasses WorkOS MFA entirely, so treat it like a password. `POST /api/v1/tokens` rejects an expiry more than 90 days from now. `GET /api/v1/tokens` (owner session only) lists each token's id, scopes, expiry, revocation time, creation time and last use, and never returns the secret hash; revoke unused or unexpected tokens with `DELETE /api/v1/tokens/<id>`. `plan auth login --stdin` is only for those tokens. Do not mint one to bypass failed WorkOS login. Deployment Protection credentials are separate from Plan Manager credentials.

## Vercel environment configuration

`config/env.contract.json` is the single list of every variable the hosted app, its production build guard, the Vercel inventory check, and CI rely on. For each name it records where it is required, whether it is a secret, the check the build applies, the minimum Vercel storage type, an obviously fake CI fixture, and an owner. `src/lib/server/env.contract.ts`, `src/env.ts`, `.env.example`, and the table below are generated from it with `pnpm contract:generate`; `pnpm contract:check` fails when any of them is stale. To add or change a variable, edit the contract, regenerate, and set the variable in Vercel before merging. Values in source and tickets must remain placeholders such as `<set-in-vercel>`.

<!-- env-contract:begin -->
<!-- Generated from config/env.contract.json by scripts/generate-env-contract.mjs. Do not edit; run `pnpm contract:generate`. -->

| Name | Required in | Sensitivity | Build check | Minimum Vercel storage type | Purpose |
| --- | --- | --- | --- | --- | --- |
| `WORKOS_CLIENT_ID` | production, preview, development | config | non-empty | production: plain; preview: plain; development: plain | WorkOS AuthKit client ID for browser sessions. |
| `WORKOS_API_KEY` | production, preview, development | secret | non-empty | production: sensitive; preview: sensitive; development: encrypted | WorkOS API key for the environment (server-only secret). |
| `WORKOS_COOKIE_PASSWORD` | production, preview, development | secret | at least 32 characters | production: sensitive; preview: sensitive; development: encrypted | Session cookie encryption password, at least 32 characters. |
| `WORKOS_REDIRECT_URI` | production, preview, development | config | non-empty | production: plain; preview: plain; development: plain | Exact browser callback URL ending in /callback. |
| `PLAN_MANAGER_OWNER_WORKOS_USER_IDS` | production, preview, development | config | comma-separated, at least one item | production: plain; preview: plain; development: plain | Comma-separated WorkOS user IDs allowed to use the app. |
| `PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN` | production, preview, development | config | non-empty | production: plain; preview: plain; development: plain | HTTPS origin of the AuthKit domain used for CLI device login. |
| `PLAN_MANAGER_WORKOS_CLI_CLIENT_ID` | production, preview, development | config | non-empty | production: plain; preview: plain; development: plain | Client ID of the public Plan Manager CLI Connect application. |
| `PLAN_MANAGER_WORKOS_CLI_AUDIENCE` | production, preview, development | config | non-empty | production: plain; preview: plain; development: plain | Audience configured for the CLI application. |
| `DATABASE_URL` | production, preview, development | secret | non-empty | production: sensitive; preview: sensitive; development: encrypted | Neon Postgres connection string. |
| `BLOB_READ_WRITE_TOKEN` | production, preview, development | secret | non-empty | production: sensitive; preview: sensitive; development: encrypted | Private Vercel Blob read/write token. |
| `PLAN_MANAGER_TOKEN_PEPPER` | production, preview, development | secret | non-empty | production: sensitive; preview: sensitive; development: encrypted | Server-side pepper for hashing CLI upload tokens. |
| `PLAN_MANAGER_HEALTH_DETAIL_TOKEN` | production | secret | at least 32 characters | production: sensitive | Bearer token for /api/health/detail; the same value is held by the production-release GitHub environment for release checks. |
| `VERCEL_TOKEN` | GitHub environment: env-audit, preview-smoke, production-release | secret | non-empty | GitHub environment secret | Personal Vercel token for trusted workflows (GitHub environment secret, never in PR CI). |
| `VERCEL_PROJECT_ID_PRODUCTION` | GitHub environment: env-audit, production-release | config | non-empty | GitHub environment secret | ID of the Git-disconnected production Vercel project (GitHub environment variable). |
| `VERCEL_PROJECT_ID_PREVIEW` | GitHub environment: env-audit, preview-smoke | config | non-empty | GitHub environment secret | ID of the Git-connected preview Vercel project (GitHub environment variable). |
| `VERCEL_ORG_ID` | GitHub environment: production-release | config | non-empty | GitHub environment secret | Vercel owner ID (personal account or team) used to link the production project for vercel build. |
| `PRODUCTION_DOMAIN` | GitHub environment: production-release | config | non-empty | GitHub environment secret | Custom production domain the release verifies after promote and rollback. |
| `VERCEL_PROTECTION_BYPASS_PRODUCTION` | GitHub environment: production-release | secret | non-empty | GitHub environment secret | Production project's Protection Bypass for Automation secret, to probe staged deployments. |
| `VERCEL_PROTECTION_BYPASS_PREVIEW` | GitHub environment: preview-smoke | secret | non-empty | GitHub environment secret | Preview project's Protection Bypass for Automation secret (treated as exposed to PR code). |

<!-- env-contract:end -->

Secrets must use the **Sensitive** storage type in Production and Preview (Vercel does not offer Sensitive for Development, so Development uses Encrypted). The build check is only a shape check; the runtime additionally validates URL shapes (`WORKOS_REDIRECT_URI` must end in `/callback`, `PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN` must be an HTTPS origin).

| Environment | Browser callback | Approved post-logout URL | CLI details |
| --- | --- | --- | --- |
| Development | `http://localhost:5173/callback` | `http://localhost:5173/` | Development AuthKit domain, public CLI client, development audience |
| Preview | `https://<stable-preview-origin>/callback` | `https://<stable-preview-origin>/` | Isolated preview AuthKit domain/client/audience; avoid unbounded preview wildcards |
| Production | `https://planmanager.hacker1db.dev/callback` | `https://planmanager.hacker1db.dev/` | Production AuthKit domain, public CLI client, production audience |

When `VERCEL_ENV=production`, `pnpm build` first runs `scripts/check-hosted-env.mjs`, which fails the build and lists (by name only) any missing or invalid hosted variable, so an unconfigured production deployment cannot go live and answer only 503. Preview and local builds skip this check.

Before merging to `main`, compare the names configured in Vercel with what the build requires. This reads only `vercel env ls --format json` metadata (name, target, type) and never requests or prints a value:

```sh
vercel link --project plan-manager --scope zerobitdev   # once per checkout
pnpm check:vercel-env                                   # every target, exit 1 if any name is missing
vercel env ls --format json | node scripts/check-vercel-env.mjs --target production
```

Presence of a name does not prove its value is valid (the build guard and runtime still check the owner list, cookie-password length, and URL shapes). To fill a gap, an operator with WorkOS and Vercel access takes each real value from the WorkOS Dashboard and adds it with `vercel env add <NAME> production --sensitive`, typing it at the prompt so it never lands in shell history or a ticket. Never add placeholder values to make the build pass. Then redeploy production from the Vercel dashboard or by pushing to `main`.

| Name | Source |
| --- | --- |
| `WORKOS_API_KEY` | WorkOS Dashboard → API Keys for the production environment (server-only secret) |
| `PLAN_MANAGER_OWNER_WORKOS_USER_IDS` | WorkOS Dashboard → Users → owner's `user_...` ID; comma-separate several |
| `PLAN_MANAGER_WORKOS_CLI_CLIENT_ID` | Client ID of the public `Plan Manager CLI` Connect application |
| `PLAN_MANAGER_WORKOS_CLI_AUDIENCE` | Audience configured for that CLI application in production |

Variable changes do not modify an existing deployment. Redeploy the affected environment, then verify browser login/logout, non-owner denial, TOTP MFA, CLI device login, token rotation, and an authorized write. Preview must pass before production.

For each browser environment, also register the exact `/sign-in` URL as the WorkOS **Sign-in endpoint** (`initiate_login_uri`). The official SvelteKit SDK uses that endpoint for WorkOS-initiated flows and routes failed callbacks to the application's public `/auth/error` page. Keep callback, sign-in, and post-logout origins environment-specific.

### Read-only inventory observed 2026-10-25

`vercel env ls --format json` against the then-linked `hacker1dbs-projects/plan-manager` project (now `zerobitdev/plan-manager`) was used only to list variable names, targets, and storage types. It did not retrieve any values. None of the previously inventoried WorkOS variables existed in Development, Preview, or Production. The SvelteKit conversion adds `WORKOS_API_KEY` and replaces `NEXT_PUBLIC_WORKOS_REDIRECT_URI` with server-only `WORKOS_REDIRECT_URI`; re-check names before any approved setup.

The project still has the Clerk-era names `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `PLAN_MANAGER_OWNER_CLERK_USER_ID`, `PLAN_MANAGER_OWNER_CLERK_USER_IDS`, and `PLAN_MANAGER_OAUTH_CLIENT_ID` across their existing environment targets. The existing database, Blob, and `PLAN_MANAGER_TOKEN_PEPPER` variables are present. Exact current client IDs and all secret values were deliberately not read, so they cannot be copied or inferred from this inventory.

Operational setup must therefore add all eight WorkOS names separately to Development, Preview, and Production. Preserve the existing Clerk variables unchanged through preview validation and the approved production rollback window; their presence is rollback state, not authorization for permanent dual-provider operation.

For rollback, retain the last known-good Clerk deployment and its associated Vercel configuration through the approved observation window. Roll back the deployment if verification fails; the database and Blob data require no reverse migration. Do not configure permanent dual-provider routing. After successful production verification and a separately approved rollback window, revoke Clerk grants/keys and remove the hosted Clerk integration.

## Preventing failed production deploys

The `ci` GitHub Actions workflow (`.github/workflows/ci.yml`, which replaces the earlier `hosted-build` workflow) runs on every pull request and on pushes to `main`. It has no secrets, no write permissions, and no caches, so it is safe on pull requests from forks. Besides typechecks and tests it runs:

- `node scripts/ci-production-build.mjs`: `pnpm build:web` with `VERCEL_ENV=production` and the fake `ciFixture` value of every variable in `config/env.contract.json`. It must pass.
- `node scripts/ci/empty-env-build.mjs`: the same build with no contract variables set. It must fail and name every production-required variable, which proves the guard still fails closed.
- `test/hosted/build-env.test.ts` and `test/hosted/env-contract.test.ts` (part of `pnpm test`): the guard fails naming only the variable when any one is missing or blank (including the four from the failed deploy: `WORKOS_API_KEY`, `PLAN_MANAGER_OWNER_WORKOS_USER_IDS`, `PLAN_MANAGER_WORKOS_CLI_CLIENT_ID`, `PLAN_MANAGER_WORKOS_CLI_AUDIENCE`), never prints a value, and the guard, the runtime, `.env.example`, and the contract require exactly the same names.
- The contract-change gate: a PR that adds a production requirement or changes a build check fails until the repository owner confirms the value is provisioned. See [`docs/operations/ci-cd.md`](operations/ci-cd.md#contract-change-gate).

**Limit:** PR CI cannot see the real Vercel settings. The contract-change gate makes the owner confirm provisioning before merge; the trusted drift audit and release workflows (see `docs/operations/ci-cd.md`) check the real settings after merge. Never add a Vercel token to a pull request workflow. Also turn on Vercel failed-deployment notifications (Account Settings → Notifications → Deployment Failures).

## Checks and recovery

```sh
pnpm typecheck
pnpm test
pnpm build
```

Production releases, promotion, and rollback are run by `release.yml`; for an incident, follow "Manual rollback" in [`docs/operations/ci-cd.md`](operations/ci-cd.md). Revoking an upload token or taking the hosted service offline leaves local Markdown intact. Database and Blob backups require their own retention policy; Git backs up application source, not hosted plan data. Local mocked checks do not make the migration production-ready; live preview and production verification remain required.

SvelteKit 3 requires all private deployment variables to be declared in `src/env.ts`, which is generated from `config/env.contract.json`; never edit it by hand. The runtime is Node 22; local tooling requires Node >=22.17.0.
