import { sveltekit } from '@sveltejs/kit/vite'
import adapter from '@sveltejs/adapter-vercel'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [sveltekit({
    adapter: adapter({ runtime: 'nodejs24.x' }),
  })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
