import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { createServer, type ViteDevServer } from "vite"

export const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))

let server: Promise<ViteDevServer> | null = null

// Loads Svelte components and SvelteKit route modules through Vite's SSR pipeline. `#lib`
// imports resolve through package.json `imports`, exactly as SvelteKit 3 bundles them.
export function viteServer(): Promise<ViteDevServer> {
  server ??= createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins: [svelte({ configFile: false })],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { external: ["@clerk/backend", "@neondatabase/serverless", "@vercel/blob", "react", "react-dom", "react-markdown"] },
  })
  return server
}

export async function load<T = Record<string, any>>(path: string): Promise<T> {
  return (await viteServer()).ssrLoadModule(path) as Promise<T>
}

export async function closeViteServer(): Promise<void> {
  if (server) await (await server).close()
  server = null
}
