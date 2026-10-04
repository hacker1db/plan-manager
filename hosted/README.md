# Hosted Plan Manager

This is the private, single-owner Vercel application for Plan Manager. The local CLI and loopback dashboard continue to work without this service.

## Security model

- Clerk authenticates browser sessions. Set `PLAN_MANAGER_OWNER_CLERK_USER_ID` to the sole permitted Clerk user ID and disable public sign-up in Clerk.
- Every non-sign-in page is protected in `proxy.ts`; every API handler authorizes again at route level.
- Plans are stored using Vercel Blob private access. Clients never receive Blob locators or URLs.
- CLI credentials are generated from the owner-only token endpoint, are scoped/expiring/revocable, and are stored by the local CLI in macOS Keychain. They are not Vercel, Clerk, Blob, database, or Deployment Protection credentials.
- Required configuration is checked at runtime and fails closed. Do not deploy without every key in `.env.example`.

## Provisioning

1. From this directory, install dependencies with `pnpm install --frozen-lockfile` after the lockfile is committed.
2. Link this directory to the intended Vercel project. Install Clerk and Neon through the Vercel Marketplace, then provision a private Vercel Blob store.
3. Pull Vercel variables with `vercel env pull .env.local --yes`. Add `PLAN_MANAGER_OWNER_CLERK_USER_ID` after signing in as the owner, and create a high-entropy `PLAN_MANAGER_TOKEN_PEPPER` as a sensitive server-only variable.
4. Confirm every key in `.env.example` exists in `.env.local` by name only. Run `pnpm db:migrate`, `pnpm typecheck`, and `pnpm test`.
5. Deploy. Optional Vercel Deployment Protection is defense in depth only. If it protects automation, maintain its bypass secret separately from plan-manager CLI tokens.

## CLI remote flow

1. As the owner, create a scoped `plans:write` token at `POST /api/v1/tokens`. The bearer value is shown once.
2. Configure the remote: `plan remote add personal https://your-project.vercel.app`.
3. Store the credential without exposing it in shell history: `pbpaste | plan auth login personal --stdin`.
4. Upload a local plan explicitly: `plan push <id-or-slug> --remote personal`. `plan push --all --remote personal` uploads each local active plan.
5. Revoke compromised tokens with `DELETE /api/v1/tokens/:id`, then run `plan auth logout personal`.

## Rollback

Remove the hosted remote from the CLI configuration or revoke its token; local plans remain canonical under `~/Developer/plans`. Disable the Vercel deployment if required. No local plan is deleted by this application.
