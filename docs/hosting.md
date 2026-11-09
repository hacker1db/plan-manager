# Hosted Plan Manager

The SvelteKit application in `src/routes` serves the private plan library at `https://planmanager.hacker1db.dev`. The CLI, local server, and hosted app share the root pnpm package and `src/` source tree. Canonical local Markdown remains in `~/notes/SecondBrain/4.Resources/plans`; uploads are explicit.

## GitHub and Vercel

Push the complete plan-manager repository to GitHub, then connect that repository to the existing `hacker1dbs-projects/plan-manager` Vercel project. Keep the existing project so its domain, integrations, and environment variables are preserved.

Set the existing Vercel project's root directory to the repository root (`.`). Use the SvelteKit framework preset, `pnpm install --frozen-lockfile` as the install command, and `pnpm build` as the build command. `@sveltejs/adapter-vercel` produces output for the explicitly selected `nodejs24.x` runtime. Select the desired production branch after it exists on GitHub. The build creates the CLI output and then builds the SvelteKit app from `src/routes`.

Commit application source, migrations, tests, `pnpm-lock.yaml`, and `.env.example`. Local `.env*` secrets, `.vercel/`, `.svelte-kit/`, `node_modules/`, and TypeScript caches are ignored. Never commit credentials or deployment-protection bypass tokens. The local `.vercel/` directory only identifies the linked project; it is not a Git backup.

The canonical browser UI lives in `src/dashboard/`. Hosted library and detail pages package the same HTML shells and JavaScript used by the local server, and generate their stylesheet, scripts, and favicon from that directory before web development and builds. Hosted APIs adapt authenticated cloud data to the browser contract; local filesystem and editor actions remain local-only. Do not maintain a second hosted dashboard implementation or a separate app package.

The stable SvelteKit 3 toolchain requires Node.js 22.17 or newer. Vercel is pinned to Node.js 24 in `vite.config.ts`; keep local development compatible.

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

After linking and verifying environment configuration, apply the initial database schema with `pnpm db:migrate`. It loads root `.env.local` and runs an idempotent transaction. Run migrations intentionally rather than as part of every deployment.

## Access and uploads

WorkOS AuthKit authenticates browser sessions; only IDs listed in `PLAN_MANAGER_OWNER_WORKOS_USER_IDS` may view or manage plans. Set it to a comma-separated allowlist of WorkOS user IDs. There is no Clerk-variable fallback. Keep public sign-up disabled and invite only approved accounts. In the WorkOS Dashboard, set Hosted AuthKit MFA to **Required**; application code cannot prove or enforce that provider policy. WorkOS documents that this built-in MFA does not apply to SSO users, so Plan Manager owners must either be prevented from using SSO or covered by separately verified MFA at the SSO identity provider. Authentication success without allowlist membership returns 403.

Every browser API checks owner authorization. Uploads require scoped, expiring, revocable CLI tokens with salted server-side hashes. Markdown uses private Vercel Blob access; API responses exclude storage locators. Hosted pages render Markdown safely and refresh when uploaded revisions change. Filesystem actions and task editing remain available in the local dashboard.

```sh
plan auth login
plan push --all
```

Create a public WorkOS Connect application named `Plan Manager CLI` with CLI Auth enabled. Assign `openid`, `offline_access`, and `plans:write`. The CLI uses the device authorization and token endpoints on the configured AuthKit domain; it does not open a localhost callback or carry a client secret. `GET /api/v1` exposes only versioned, nonsecret client configuration. The API accepts a CLI access token only after RS256 signature, exact issuer, audience, client ID, `plans:write` scope, and owner-subject checks.

The CLI targets `https://planmanager.hacker1db.dev` by default; set `PLAN_MANAGER_URL` to use another deployment. `plan auth login` prints a user code and WorkOS verification URL, then stores the returned access and rotating refresh pair in macOS Keychain. `plan auth logout` removes the local credential; revoke the WorkOS grant separately when provider-side invalidation is required. Version-1 Clerk records require a new login.

Existing `pm_...` Plan Manager tokens remain an explicit compatibility bridge. They are scoped, expiring, revocable, and hashed at rest, but they are bearer credentials with no WorkOS session or TOTP binding. `plan auth login --stdin` is only for those tokens. Do not mint one to bypass failed WorkOS login. Deployment Protection credentials are separate from Plan Manager credentials. See [`auth.md`](../auth.md) for the full threat boundary.

## Vercel environment configuration

Set these exact variables independently for Development, Preview, and Production: `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`, `PLAN_MANAGER_OWNER_WORKOS_USER_IDS`, `PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN`, `PLAN_MANAGER_WORKOS_CLI_CLIENT_ID`, and `PLAN_MANAGER_WORKOS_CLI_AUDIENCE`. Preserve the existing `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, and `PLAN_MANAGER_TOKEN_PEPPER`. Values in source and tickets must remain placeholders such as `<set-in-vercel>`.

| Environment | Browser callback | Approved post-logout URL | CLI details |
| --- | --- | --- | --- |
| Development | `http://localhost:5173/callback` | `http://localhost:5173/` | Development AuthKit domain, public CLI client, development audience |
| Preview | `https://<stable-preview-origin>/callback` | `https://<stable-preview-origin>/` | Isolated preview AuthKit domain/client/audience; avoid unbounded preview wildcards |
| Production | `https://planmanager.hacker1db.dev/callback` | `https://planmanager.hacker1db.dev/` | Production AuthKit domain, public CLI client, production audience |

Variable changes do not modify an existing deployment. Redeploy the affected environment, then verify browser login/logout, non-owner denial, TOTP MFA, CLI device login, token rotation, and an authorized write. Preview must pass before production.

For each browser environment, also register the exact `/sign-in` URL as the WorkOS **Sign-in endpoint** (`initiate_login_uri`). The official SvelteKit SDK uses that endpoint for WorkOS-initiated flows and routes failed callbacks to the application's public `/auth/error` page. Keep callback, sign-in, and post-logout origins environment-specific.

### Read-only inventory observed 2026-10-25

`vercel env ls --format json` against the already linked `hacker1dbs-projects/plan-manager` project was used only to list variable names, targets, and storage types. It did not retrieve any values. None of the previously inventoried WorkOS variables existed in Development, Preview, or Production. The SvelteKit conversion adds `WORKOS_API_KEY` and replaces `NEXT_PUBLIC_WORKOS_REDIRECT_URI` with server-only `WORKOS_REDIRECT_URI`; re-check names before any approved setup.

The project still has the Clerk-era names `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `PLAN_MANAGER_OWNER_CLERK_USER_ID`, `PLAN_MANAGER_OWNER_CLERK_USER_IDS`, and `PLAN_MANAGER_OAUTH_CLIENT_ID` across their existing environment targets. The existing database, Blob, and `PLAN_MANAGER_TOKEN_PEPPER` variables are present. Exact current client IDs and all secret values were deliberately not read, so they cannot be copied or inferred from this inventory.

Operational setup must therefore add all eight WorkOS names separately to Development, Preview, and Production. Preserve the existing Clerk variables unchanged through preview validation and the approved production rollback window; their presence is rollback state, not authorization for permanent dual-provider operation.

For rollback, retain the last known-good Clerk deployment and its associated Vercel configuration through the approved observation window. Roll back the deployment if verification fails; the database and Blob data require no reverse migration. Do not configure permanent dual-provider routing. After successful production verification and a separately approved rollback window, revoke Clerk grants/keys and remove the hosted Clerk integration.

## Checks and recovery

```sh
pnpm typecheck
pnpm test
pnpm build
```

Roll back through the existing Vercel project's deployment history. Revoking an upload token or taking the hosted service offline leaves local Markdown intact. Database and Blob backups require their own retention policy; Git backs up application source, not hosted plan data. Local mocked checks do not make the migration production-ready; live preview and production verification remain required.

SvelteKit 3 requires all private deployment variables to be declared in `src/env.ts`. Keep the WorkOS variables declared there when changing deployment configuration. The runtime is Node 22; local tooling requires Node >=22.17.0.
