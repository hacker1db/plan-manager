import adapter from "@sveltejs/adapter-vercel"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Node runtime: token hashing uses node:crypto scrypt and Neon/Blob server SDKs.
    adapter: adapter({ runtime: "nodejs22.x" }),
    // SvelteKit's default CSRF origin check stays on for form submissions; JSON mutations
    // also verify the Origin header in their handlers (src/lib/server/security.ts).
  },
}

export default config
