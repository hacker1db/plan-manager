// Generated from config/env.contract.json by scripts/generate-env-contract.mjs. Do not edit; run `pnpm contract:generate`.
export type EnvValidator =
  | { readonly id: "nonEmpty" }
  | { readonly id: "csvNonEmpty" }
  | { readonly id: "minLength"; readonly min: number }

export type ContractVariable = { readonly name: string; readonly validator: EnvValidator }

// Required by getHostedEnvironment(), in contract order.
export const HOSTED_RUNTIME_VARIABLES = [
  { name: "WORKOS_CLIENT_ID", validator: { id: "nonEmpty" } },
  { name: "WORKOS_API_KEY", validator: { id: "nonEmpty" } },
  { name: "WORKOS_COOKIE_PASSWORD", validator: { id: "minLength", min: 32 } },
  { name: "WORKOS_REDIRECT_URI", validator: { id: "nonEmpty" } },
  { name: "PLAN_MANAGER_OWNER_WORKOS_USER_IDS", validator: { id: "csvNonEmpty" } },
  { name: "DATABASE_URL", validator: { id: "nonEmpty" } },
  { name: "BLOB_READ_WRITE_TOKEN", validator: { id: "nonEmpty" } },
  { name: "PLAN_MANAGER_TOKEN_PEPPER", validator: { id: "nonEmpty" } },
] as const satisfies readonly ContractVariable[]

// Required by getCliOAuthConfiguration(), in contract order.
export const CLI_RUNTIME_VARIABLES = [
  { name: "PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN", validator: { id: "nonEmpty" } },
  { name: "PLAN_MANAGER_WORKOS_CLI_CLIENT_ID", validator: { id: "nonEmpty" } },
  { name: "PLAN_MANAGER_WORKOS_CLI_AUDIENCE", validator: { id: "nonEmpty" } },
] as const satisfies readonly ContractVariable[]

// Required by the /api/health/detail endpoint, in contract order.
export const HEALTH_RUNTIME_VARIABLES = [
  { name: "PLAN_MANAGER_HEALTH_DETAIL_TOKEN", validator: { id: "minLength", min: 32 } },
] as const satisfies readonly ContractVariable[]
