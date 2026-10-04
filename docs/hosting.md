# Hosted Plan Manager

The Next.js application in `src/app` serves the private plan library at `https://planmanager.hacker1db.dev`. The CLI, local server, and hosted app share the root pnpm package and `src/` source tree. Canonical local Markdown remains in `~/Developer/plans`; uploads are explicit.

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

Every key listed in `.env.example` is required at runtime. Keep its template values empty. The owner ID and token pepper must be configured as well as the Clerk, Neon, and private Blob integration variables. Environment pulls can overwrite an existing local file; preserve local-only values before pulling.

After linking and verifying environment configuration, apply the initial database schema with `pnpm db:migrate`. It loads root `.env.local` and runs an idempotent transaction. Run migrations intentionally rather than as part of every deployment.

## Access and uploads

Clerk authenticates browser sessions; only `PLAN_MANAGER_OWNER_CLERK_USER_ID` may view plans. Disable public sign-up in Clerk. The current deployment uses a Clerk development instance; production Clerk setup remains a separate deployment task.

Every browser API checks owner authorization. Uploads require scoped, expiring, revocable CLI tokens with salted server-side hashes. Markdown uses private Vercel Blob access; API responses exclude storage locators. Hosted pages render Markdown safely and refresh when uploaded revisions change. Filesystem actions and task editing remain available in the local dashboard.

```sh
plan remote add personal https://planmanager.hacker1db.dev
pbpaste | plan auth login personal --stdin
plan push --all --remote personal
```

Create CLI tokens through the owner-authorized `POST /api/v1/tokens` endpoint. The plaintext bearer is returned once. `plan auth login` stores it in macOS Keychain. Revoke a token using `DELETE /api/v1/tokens/:id`, then remove its local credential with `plan auth logout personal`. Deployment Protection credentials are separate from plan-manager credentials.

## Checks and recovery

```sh
pnpm typecheck
pnpm test
pnpm build
```

Roll back through the existing Vercel project's deployment history. Revoking an upload token or taking the hosted service offline leaves local Markdown intact. Database and Blob backups require their own retention policy; Git backs up application source, not hosted plan data.
