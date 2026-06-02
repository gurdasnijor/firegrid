// firegrid-quality-gates.PREFLIGHT.1
// firegrid-quality-gates.PREFLIGHT.2
// firegrid-quality-gates.PREFLIGHT.3
//
// Local PR preflight runner. Unlike `pnpm run verify`, this script keeps
// running after a failure so the developer sees every failing gate in one pass.

import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import process from "node:process"

const gates = [
  ["check:specs", "Feature spec YAML syntax"],
  ["check:docs", "Documentation hygiene"],
  ["typecheck", "TypeScript project references"],
  ["lint", "ESLint and production cutover checks"],
  ["lint:dead", "Knip dead-code ratchet"],
  ["lint:dup", "jscpd duplicate-code ratchet"],
  ["lint:deps", "Dependency cruiser boundaries"],
  ["lint:effect-quality", "Effect-quality metrics ratchet"],
  ["trace:seams:ukv", "UKV production trace seam gate"],
  ["lint:semgrep:test", "Semgrep rule fixtures"],
  ["lint:semgrep", "Semgrep ERROR baseline gate"],
  ["lint:host-sdk-imports", "host-sdk runtime-import quarantine (Wave C)"],
  ["effect:diagnostics", "Effect language service diagnostics"],
  ["test", "Workspace test suite"],
]

const failures = []

for (const [script, description] of gates) {
  log(`\n== pnpm run ${script} ==`)
  log(description)

  const result = spawnSync("pnpm", ["run", script], {
    stdio: "inherit",
    env: process.env,
  })

  if (result.error !== undefined) {
    failures.push([script, result.error.message])
    error(`FAILED ${script}: ${result.error.message}`)
    continue
  }

  if (result.status !== 0) {
    failures.push([script, `exit ${String(result.status)}`])
    error(`FAILED ${script}: exit ${String(result.status)}`)
  } else {
    log(`OK ${script}`)
  }
}

log("\n== preflight summary ==")
if (failures.length === 0) {
  log("All gates passed.")
  process.exit(0)
}

for (const [script, reason] of failures) {
  error(`- ${script}: ${reason}`)
}

error(`Preflight failed: ${failures.length} gate(s) failed.`)
process.exit(1)
