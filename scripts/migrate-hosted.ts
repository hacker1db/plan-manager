import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { neon } from "@neondatabase/serverless"

// Applies every src/lib/server/migrations/*.sql file in name order, each in its own transaction.
// Every migration is written to be idempotent (IF NOT EXISTS), so re-running is safe.
export async function migrationFiles(directory = join(process.cwd(), "src/lib/server/migrations")): Promise<string[]> {
  return (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => join(directory, name))
}

export function migrationStatements(migration: string): string[] {
  return migration
    .split("\n").filter(line => !line.trim().startsWith("--")).join("\n")
    .split(";").map(statement => statement.trim()).filter(Boolean)
}

async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const sql = neon(process.env.DATABASE_URL)
  for (const file of await migrationFiles()) {
    const statements = migrationStatements(await readFile(file, "utf8"))
    await sql.transaction(statements.map(statement => sql.query(statement)))
    process.stdout.write(`Applied hosted Plan Manager migration ${basename(file)}.\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch(() => {
    process.stderr.write("Hosted migration failed; verify DATABASE_URL and database connectivity.\n")
    process.exitCode = 1
  })
}
