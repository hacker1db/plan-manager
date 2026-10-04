import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { neon } from "@neondatabase/serverless"

async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const migration = await readFile(join(process.cwd(), "src/hosted/migrations/001_initial.sql"), "utf8")
  const sql = neon(process.env.DATABASE_URL)
  const statements = migration.split(";").map(statement => statement.trim()).filter(Boolean)
  await sql.transaction(statements.map(statement => sql.query(statement)))
  process.stdout.write("Applied hosted Plan Manager migration 001.\n")
}

migrate().catch(() => {
  process.stderr.write("Hosted migration failed; verify DATABASE_URL and database connectivity.\n")
  process.exitCode = 1
})
