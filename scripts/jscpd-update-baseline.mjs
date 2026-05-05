import { execSync } from "node:child_process"
import { error, log } from "node:console"
import { readFileSync, writeFileSync } from "node:fs"
import process from "node:process"

// firegrid-remediation-hardening.DUP_DETECTION.4
execSync("pnpm jscpd packages/*/src apps/*/src --reporters json --output .jscpd-report --threshold 100", {
  stdio: "inherit",
})

const report = JSON.parse(readFileSync(".jscpd-report/jscpd-report.json", "utf8"))
const count = report.statistics?.total?.duplicatedLines ?? 0
const cfg = JSON.parse(readFileSync(".jscpd.json", "utf8"))

if (typeof cfg.threshold === "number" && count > cfg.threshold) {
  error(
    `Refusing to ratchet up: current=${count} > existing threshold=${cfg.threshold}. Fix duplications first.`,
  )
  process.exit(1)
}

cfg.threshold = count
writeFileSync(".jscpd.json", `${JSON.stringify(cfg, null, 2)}\n`)
log(`Baseline updated: threshold=${count}`)
