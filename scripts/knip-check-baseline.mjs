import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { readFileSync } from "node:fs"
import process from "node:process"

const runKnipJson = () => {
  const result = spawnSync("pnpm", ["knip", "--reporter", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (result.status !== 0 && result.status !== 1) {
    error(`knip failed with exit code ${String(result.status)}`)
    process.exit(result.status ?? 1)
  }

  return JSON.parse(result.stdout)
}

const countIssues = (report) =>
  Object.values(report).reduce((total, value) => {
    if (Array.isArray(value)) return total + value.length
    if (value == null || typeof value !== "object") return total
    return total + countIssues(value)
  }, 0)

// firegrid-remediation-hardening.STATIC_QUALITY.1
const report = runKnipJson()
const current = countIssues(report)
const baseline = JSON.parse(readFileSync(".knip-baseline.json", "utf8"))
const threshold = baseline.issueCount

if (typeof threshold !== "number") {
  error("Invalid .knip-baseline.json: expected numeric issueCount.")
  process.exit(1)
}

if (current > threshold) {
  error(`Dead-code regression: current=${current} > baseline=${threshold}.`)
  process.exit(1)
}

log(`Dead-code baseline OK: current=${current}, baseline=${threshold}`)
