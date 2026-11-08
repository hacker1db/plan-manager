import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { createServer, type ViteDevServer } from "vite"

export const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))

let server: Promise<ViteDevServer> | null = null

// Loads Svelte components and SvelteKit route modules through Vite's SSR pipeline with the
// app's `$lib` alias, so tests exercise the exact modules SvelteKit bundles.
export function viteServer(): Promise<ViteDevServer> {
  server ??= createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins: [svelte({ configFile: false })],
    resolve: { alias: { $lib: resolve(root, "src/lib") } },
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
