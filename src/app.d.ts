import type { AuthReader } from "#lib/server/auth.ts"

declare global {
  namespace App {
    interface Locals {
      // Clerk auth for this request; see src/lib/server/clerk.ts.
      auth: AuthReader
    }
  }
}

export {}
