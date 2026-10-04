// @ts-nocheck
import { initStorage, planHome, archiveDir } from '../../lib/storage.js'
import { EXIT } from '../exit.js'

export async function cmdInit(args, opts) {
  try {
    await initStorage()
    if (!opts.json) {
      process.stdout.write(`Plan home initialized:\n  ${planHome()}\n  ${archiveDir()}\n`)
    } else {
      process.stdout.write(JSON.stringify({ version: 1, ok: true, planHome: planHome(), archiveDir: archiveDir() }) + '\n')
    }
  } catch (err) {
    if (err.code === 'ENOTDIR') {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(EXIT.STORAGE_UNAVAILABLE)
    }
    throw err
  }
}
