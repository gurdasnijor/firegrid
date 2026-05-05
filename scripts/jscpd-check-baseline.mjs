import { execSync } from "node:child_process"
import { error, log } from "node:console"
import { readFileSync } from "node:fs"
import process from "node:process"

// firegrid-remediation-hardening.DUP_DETECTION.1
// firegrid-remediation-hardening.DUP_DETECTION.5
execSync("pnpm jscpd packages/*/src apps/*/src --reporters console,json --output .jscpd-report --threshold 100", {
  stdio: "inherit",
})

const report = JSON.parse(readFileSync(".jscpd-report/jscpd-report.json", "utf8"))
const count = report.statistics?.total?.duplicatedLines ?? 0
const cfg = JSON.parse(readFileSync(".jscpd.json", "utf8"))
const threshold = cfg.threshold

if (typeof threshold !== "number") {
  error("Invalid .jscpd.json threshold: expected a duplicated-line count.")
  process.exit(1)
}

if (count > threshold) {
  error(`Duplication regression: current=${count} > threshold=${threshold}.`)
  process.exit(1)
}

log(`Duplication baseline OK: current=${count}, threshold=${threshold}`)
