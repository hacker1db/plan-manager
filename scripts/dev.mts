import { run } from '../src/cli/index.js'

run(process.argv.slice(2)).catch(error => {
  process.stderr.write(`Unexpected error: ${error.message}\n`)
  process.exit(1)
})
