// Regenerates golden/*.json from the TypeScript renderer the hosted app uses
// (src/lib/mdx), which is the spec for the Go port. Run from the repository root:
//
//   TSX_TSCONFIG_PATH=tsconfig.tests.json node --import tsx cli/internal/mdxrender/testdata/generate.mjs
//
// Each corpus/<name>.mdx becomes golden/<name>.json with the rendered HTML
// (renderMdxToHtml) and the `plan check` problems (checkMdx). cases.json holds
// many short sources; its results go to golden/cases.json in the same order.
// blocks.json and blocks.md are `plan blocks --json` and `plan blocks`.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { BLOCKS, blocksReference } from '../../../../src/lib/mdx/blocks.ts'
import { checkMdx, renderMdxToHtml } from '../../../../src/lib/mdx/html.tsx'

const here = new URL('./', import.meta.url)
const corpus = new URL('corpus/', here)
const golden = new URL('golden/', here)
await mkdir(golden, { recursive: true })
for (const name of (await readdir(corpus)).filter(file => file.endsWith('.mdx')).sort()) {
  const source = await readFile(new URL(name, corpus), 'utf8')
  const result = { html: renderMdxToHtml(source), problems: checkMdx(source) }
  await writeFile(new URL(name.replace(/\.mdx$/, '.json'), golden), JSON.stringify(result, null, 2) + '\n')
}
const cases = JSON.parse(await readFile(new URL('cases.json', here), 'utf8'))
const results = cases.map(source => ({ html: renderMdxToHtml(source), problems: checkMdx(source) }))
await writeFile(new URL('golden/cases.json', here), JSON.stringify(results, null, 1) + '\n')
await writeFile(new URL('blocks.json', here), JSON.stringify({ version: 1, blocks: BLOCKS }) + '\n')
await writeFile(new URL('blocks.md', here), blocksReference())
