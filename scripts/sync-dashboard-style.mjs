// Packages the canonical local dashboard (src/dashboard) for the hosted SvelteKit app:
// static/ browser scripts and icon, src/app.css, and the HTML shell bodies. All outputs
// are generated and gitignored; never edit them directly.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dashboard = resolve(root, 'src/dashboard')
const publicDir = resolve(root, 'static')
const generatedDir = resolve(root, 'src/lib/hosted')
await mkdir(publicDir, { recursive: true })
await mkdir(generatedDir, { recursive: true })

for (const filename of ['app.js', 'plan.js']) {
  await cp(resolve(dashboard, filename), resolve(publicDir, filename))
}
await cp(resolve(dashboard, 'icon.png'), resolve(publicDir, 'dashboard-icon.png'))
await cp(resolve(dashboard, 'style.css'), resolve(root, 'src/app.css'))

async function body(filename) {
  const source = await readFile(resolve(dashboard, filename), 'utf8')
  const match = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  if (!match) throw new Error(`Dashboard shell has no body: ${filename}`)
  return match[1].replace(/\s*<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
}

const library = await body('index.html')
const plan = await body('plan.html')
const generated = `export const libraryBody = ${JSON.stringify(library)}\nexport const planBody = ${JSON.stringify(plan)}\n`
await writeFile(resolve(generatedDir, 'generated-dashboard.ts'), generated)
