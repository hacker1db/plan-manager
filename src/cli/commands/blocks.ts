// @ts-nocheck
import { BLOCKS, blocksReference } from '../../lib/mdx/blocks.js'

export async function cmdBlocks(args, opts) {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ version: 1, blocks: BLOCKS }) + '\n')
    return
  }
  process.stdout.write(blocksReference())
}
