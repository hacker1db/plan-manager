#!/bin/sh
# Runs the TypeScript CLI's node:test contract suites against the Go binary.
# The suites spawn `node bin/plan ...` and import dist/server/server.js, so this
# stages them next to a bin/plan shim and a startServer() shim that launch Go.
set -eu

cli_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_dir=$(cd "$cli_dir/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$cli_dir" && go build -o "$work/plan-go" ./cmd/plan)

mkdir -p "$work/bin" "$work/test/cli" "$work/dist/server"
echo '{"type":"module"}' > "$work/package.json"
cp "$repo_dir"/test/cli/create.test.js "$repo_dir"/test/cli/capture.test.js \
   "$repo_dir"/test/cli/contracts.test.js "$repo_dir"/test/cli/dashboard.test.js "$work/test/cli/"
# doctor reports the Go runtime under "runtime" rather than "node".
sed -i.bak 's/assert.ok(report.node)/assert.ok(report.runtime)/' "$work/test/cli/create.test.js"

cat > "$work/bin/plan" <<EOF
#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const r = spawnSync('$work/plan-go', process.argv.slice(2), { stdio: 'inherit' })
process.exit(r.status ?? 1)
EOF

cat > "$work/dist/server/server.js" <<EOF
import { spawn } from 'node:child_process'

export function startServer(options = {}) {
  const env = {
    ...process.env,
    PLAN_HOME: options.planHome,
    PLAN_PORT: String(options.port ?? 0),
    PLAN_HOST: options.host ?? '127.0.0.1',
    ...(options.watch === false ? { PLAN_WATCH: '0' } : {}),
    ...(options.watchDebounceMs ? { PLAN_WATCH_DEBOUNCE_MS: String(options.watchDebounceMs) } : {}),
    ...(options.stabilityDelayMs ? { PLAN_STABILITY_DELAY_MS: String(options.stabilityDelayMs) } : {}),
    ...(options.reconcileIntervalMs ? { PLAN_RECONCILE_INTERVAL_MS: String(options.reconcileIntervalMs) } : {}),
  }
  const child = spawn('$work/plan-go', ['serve', '--foreground', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    child.stderr.on('data', c => { err += c })
    child.stdout.on('data', c => {
      out += c
      const line = out.split('\n').find(l => l.startsWith('{'))
      if (!line) return
      const info = JSON.parse(line)
      resolve({
        url: info.dashboardUrl,
        host: info.host,
        port: Number(new URL(info.dashboardUrl).port),
        // The Go server reconciles on its own timer; wait out one cycle.
        reconcile: () => new Promise(r => setTimeout(r, (options.reconcileIntervalMs ?? 1000) * 2 + (options.stabilityDelayMs ?? 120) * 2 + 50)),
        close: () => new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM') }),
      })
    })
    child.once('exit', code => {
      const e = new Error(err.trim() || 'exited ' + code)
      e.exitCode = code
      e.code = code === 9 ? 'EADDRINUSE' : code === 2 ? 'EHOSTUNSAFE' : 'EUNKNOWN'
      reject(e)
    })
  })
}
EOF

cd "$work"
node --test --test-timeout=30000 --test-skip-pattern="pnpm dev" test/cli/*.test.js
