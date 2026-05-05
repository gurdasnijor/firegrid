import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { readFileSync, writeFileSync } from "node:fs"
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

const report = runKnipJson()
const issueCount = countIssues(report)

let existing
try {
  existing = JSON.parse(readFileSync(".knip-baseline.json", "utf8"))
} catch {
  existing = {}
}

if (typeof existing.issueCount === "number" && issueCount > existing.issueCount) {
  error(
    `Refusing to ratchet up: current=${issueCount} > existing baseline=${existing.issueCount}. Fix dead-code findings first.`,
  )
  process.exit(1)
}

writeFileSync(
  ".knip-baseline.json",
  `${JSON.stringify({ issueCount, report }, null, 2)}\n`,
)
log(`Knip baseline updated: issueCount=${issueCount}`)
