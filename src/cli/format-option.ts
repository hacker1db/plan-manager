// @ts-nocheck
import { isPlanFormat } from '../lib/mdx/format.js'
import { EXIT } from './exit.js'

export function requestedFormat(opts, fallback) {
  if (opts.format === undefined) return fallback
  if (isPlanFormat(opts.format)) return opts.format
  process.stderr.write('Error: --format must be md or mdx\n')
  process.exit(EXIT.INVALID_INPUT)
}
