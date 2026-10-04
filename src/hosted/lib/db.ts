import { neon, type NeonQueryFunction } from "@neondatabase/serverless"
import { getHostedEnvironment } from "./env"

let sql: NeonQueryFunction<false, false> | undefined

export function getSql(): NeonQueryFunction<false, false> {
  if (!sql) sql = neon(getHostedEnvironment().databaseUrl)
  return sql
}
