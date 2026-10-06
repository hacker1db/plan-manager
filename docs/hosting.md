# Hosted Plan Manager

The Next.js application in `src/app` serves the private plan library at `https://planmanager.hacker1db.dev`. The CLI, local server, and hosted app share the root pnpm package and `src/` source tree. Canonical local Markdown remains in `~/notes/SecondBrain/4.Resources/plans`; uploads are explicit.

## GitHub and Vercel

Push the complete plan-manager repository to GitHub, then connect that repository to the existing `hacker1dbs-projects/plan-manager` Vercel project. Keep the existing project so its domain, integrations, and environment variables are preserved.

Set the existing Vercel project's root directory to the repository root (`.`). Use the Next.js framework preset, `pnpm install --frozen-lockfile` as the install command, and `pnpm build` as the build command. Next.js manages the output directory. Select the desired production branch after it exists on GitHub. The build creates the CLI output and then builds the Next.js app from `src/app`.

Commit application source, migrations, tests, `pnpm-lock.yaml`, and `.env.example`. Local `.env*` secrets, `.vercel/`, `.next/`, `node_modules/`, and TypeScript caches are ignored. Never commit credentials or deployment-protection bypass tokens. The local `.vercel/` directory only identifies the linked project; it is not a Git backup.

The canonical browser UI lives in `src/dashboard/`. Hosted library and detail pages package the same HTML shells and JavaScript used by the local server, and generate their stylesheet, scripts, and favicon from that directory before web development and builds. Hosted APIs adapt authenticated cloud data to the browser contract; local filesystem and editor actions remain local-only. Do not maintain a second hosted dashboard implementation or a separate app package.

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

All required keys in `.env.example` must be configured at runtime; `PLAN_MANAGER_OAUTH_CLIENT_ID` is needed only for CLI Authorization Code + PKCE login. Keep template values empty. The owner ID and token pepper must be configured as well as the Clerk, Neon, and private Blob integration variables. Environment pulls can overwrite an existing local file; preserve local-only values before pulling.

After linking and verifying environment configuration, apply the initial database schema with `pnpm db:migrate`. It loads root `.env.local` and runs an idempotent transaction. Run migrations intentionally rather than as part of every deployment.

## Access and uploads

Clerk authenticates browser sessions; only IDs listed in `PLAN_MANAGER_OWNER_CLERK_USER_IDS` may view or manage plans. Set it to a comma-separated allowlist of Clerk user IDs. The legacy `PLAN_MANAGER_OWNER_CLERK_USER_ID` remains supported as a single-user fallback. Disable public sign-up in Clerk and invite only the accounts that should share this plan library. The current deployment uses a Clerk development instance; production Clerk setup remains a separate deployment task.

Every browser API checks owner authorization. Uploads require scoped, expiring, revocable CLI tokens with salted server-side hashes. Markdown uses private Vercel Blob access; API responses exclude storage locators. Hosted pages render Markdown safely and refresh when uploaded revisions change. Filesystem actions and task editing remain available in the local dashboard.

```sh
plan auth login
plan push --all
```

Configure a public Clerk OAuth application named `Plan Manager CLI` in the same Clerk instance used by the hosted dashboard. Enable Authorization Code with PKCE and require PKCE (S256). Assign the `openid` and `offline_access` scopes. Register `http://127.0.0.1/callback` as the loopback redirect URI exactly: do not use `localhost`, HTTPS, or the hosted Plan Manager URL. The CLI opens an ephemeral loopback listener and sends `http://127.0.0.1:<random-port>/callback`; Clerk must permit the variable loopback port for this registered native-app redirect URI. Set the app's public Client ID as `PLAN_MANAGER_OAUTH_CLIENT_ID` in the hosted environment and redeploy. The public `GET /api/v1` endpoint exposes only that Client ID and the Clerk issuer derived from the publishable key.

The CLI targets `https://planmanager.hacker1db.dev` by default; set `PLAN_MANAGER_URL` to use another deployment. Run `plan auth login`. The CLI opens Clerk in a browser, validates the callback `state`, exchanges the returned authorization code with its S256 PKCE verifier, and stores access and refresh tokens in macOS Keychain. It refreshes the access token as needed. `plan auth logout` removes the local credential; revoke the app grant in Clerk as well when you want to invalidate its long-lived refresh token. Clerk OAuth tokens are verified by Clerk; the API accepts them only when they were issued to the `PLAN_MANAGER_OAUTH_CLIENT_ID` application and belong to an allowlisted owner. (Clerk custom scopes can only be created in the dashboard, which is unavailable for Vercel Marketplace-provisioned apps, so the client ID binding replaces a `plans:write` scope.) Existing `pm_...` Plan Manager tokens remain supported during migration; `plan auth login --stdin` is only for those legacy tokens. Deployment Protection credentials are separate from plan-manager credentials.

## Checks and recovery

```sh
pnpm typecheck
pnpm test
pnpm build
```

Roll back through the existing Vercel project's deployment history. Revoking an upload token or taking the hosted service offline leaves local Markdown intact. Database and Blob backups require their own retention policy; Git backs up application source, not hosted plan data.
