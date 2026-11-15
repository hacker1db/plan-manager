import adapter from "@sveltejs/adapter-vercel"
import { sveltekit } from "@sveltejs/kit/vite"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"
import { CSP_DIRECTIVES } from "./src/lib/server/csp.ts"

type CspDirectives = NonNullable<NonNullable<NonNullable<Parameters<typeof sveltekit>[0]>["csp"]>["directives"]>

// SvelteKit 3 reads project configuration from the Vite plugin; svelte.config.js is no longer used.
export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // Node runtime: token hashing uses node:crypto scrypt and Neon/Blob server SDKs.
      adapter: adapter({ runtime: "nodejs22.x" }),
      // Nonce-based CSP for rendered pages (hashes if a page is ever prerendered). See csp.ts.
      csp: { mode: "auto", directives: Object.fromEntries(Object.entries(CSP_DIRECTIVES).map(([name, sources]) => [name, [...sources]])) as CspDirectives },
      // SvelteKit's CSRF origin check stays on for form submissions; JSON mutations
      // also verify the Origin header in their handlers (src/lib/server/security.ts).
    }),
  ],
})
