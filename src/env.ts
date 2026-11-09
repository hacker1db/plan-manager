import {defineEnvVars} from "@sveltejs/kit/env"
const optional = {schema: (value: string | undefined) => value}
export const variables = defineEnvVars({
  WORKOS_CLIENT_ID: optional,
  WORKOS_API_KEY: optional,
  WORKOS_COOKIE_PASSWORD: optional,
  WORKOS_REDIRECT_URI: optional,
  PLAN_MANAGER_OWNER_WORKOS_USER_IDS: optional,
  PLAN_MANAGER_WORKOS_AUTHKIT_DOMAIN: optional,
  PLAN_MANAGER_WORKOS_CLI_CLIENT_ID: optional,
  PLAN_MANAGER_WORKOS_CLI_AUDIENCE: optional,
  PLAN_MANAGER_TOKEN_PEPPER: optional,
  DATABASE_URL: optional,
  BLOB_READ_WRITE_TOKEN: optional,
})
