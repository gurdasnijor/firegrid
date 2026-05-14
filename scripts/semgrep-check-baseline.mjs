// firegrid-remediation-hardening.STATIC_QUALITY.6
// firegrid-remediation-hardening.STATIC_QUALITY.7
// firegrid-remediation-hardening.STATIC_QUALITY.13
//
// Blocking Semgrep gate for ERROR-severity rules. Existing findings are
// tracked in semgrep-error-baseline.json so new unbaselined authority
// regressions fail CI without forcing broad remediation into the rule PR.

import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "semgrep-error-baseline.json")

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
const allowed = new Set(
  (baseline.findings ?? []).map(finding =>
    `${finding.ruleId}\0${finding.path}\0${finding.line}`),
)

const result = spawnSync("semgrep", [
  "--json",
  "--severity",
  "ERROR",
  "--config",
  ".semgrep.yml",
  "packages",
  "apps",
], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
})

if (result.error !== undefined) {
  error(`Failed to run semgrep: ${result.error.message}`)
  process.exit(1)
}

if (result.status !== 0) {
  if (result.stderr.trim().length > 0) error(result.stderr.trim())
  error(`semgrep exited with status ${result.status}`)
  process.exit(result.status ?? 1)
}

const report = JSON.parse(result.stdout)
const current = report.results.map(result => ({
  ruleId: result.check_id,
  path: result.path,
  line: result.start.line,
}))

let failures = 0
for (const finding of current) {
  const key = `${finding.ruleId}\0${finding.path}\0${finding.line}`
  if (!allowed.has(key)) {
    error(
      `Unbaselined Semgrep ERROR finding: ${finding.ruleId} ${finding.path}:${finding.line}`,
    )
    failures += 1
  }
}

const currentKeys = new Set(
  current.map(finding => `${finding.ruleId}\0${finding.path}\0${finding.line}`),
)
for (const finding of baseline.findings ?? []) {
  const key = `${finding.ruleId}\0${finding.path}\0${finding.line}`
  if (!currentKeys.has(key)) {
    log(
      `Semgrep ERROR baseline improvement (remove from baseline): ${finding.ruleId} ${finding.path}:${finding.line}`,
    )
  }
}

if (failures > 0) {
  process.exit(1)
}

log(`Semgrep ERROR baseline OK: current=${current.length}, baseline=${allowed.size}`)
