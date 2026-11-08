import { defineEnvVars } from "@sveltejs/kit/env"

// SvelteKit 3 only exposes variables declared here (via $app/env/private). Every variable is
// private and optional: names are unchanged from the Next.js app, and src/lib/server/env.ts keeps
// failing closed (503) when required ones are missing instead of crashing the server on startup.
// NEXT_PUBLIC_* names are historical; they are read on the server and passed to the browser
// through the root layout load, never inlined into client bundles.
const optional = { schema: (value: string | undefined) => value }

export const variables = defineEnvVars({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { ...optional, description: "Clerk publishable key (sent to the browser by the root layout)" },
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: { ...optional, description: "Optional Clerk sign-in URL; defaults to the Account Portal" },
  CLERK_SECRET_KEY: { ...optional, description: "Clerk secret key" },
  PLAN_MANAGER_OWNER_CLERK_USER_IDS: { ...optional, description: "Comma-separated allowlist of Clerk owner user IDs" },
  PLAN_MANAGER_OWNER_CLERK_USER_ID: { ...optional, description: "Legacy single owner Clerk user ID" },
  PLAN_MANAGER_OAUTH_CLIENT_ID: { ...optional, description: "Clerk OAuth application client ID for the CLI" },
  PLAN_MANAGER_TOKEN_PEPPER: { ...optional, description: "Pepper for hashing CLI write tokens" },
  DATABASE_URL: { ...optional, description: "Neon Postgres connection string" },
  BLOB_READ_WRITE_TOKEN: { ...optional, description: "Vercel Blob read/write token" },
})
