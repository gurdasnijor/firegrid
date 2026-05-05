// firegrid-remediation-hardening.STATIC_QUALITY.10
// firegrid-remediation-hardening.STATIC_QUALITY.11
//
// AST-precise per-pattern Effect-quality metric ratchet check.
// Re-uses the ts-morph project the artifact inventory already builds
// so we get a single project crawl and AST-accurate counts (no
// grep false positives on comments, multi-line imports, etc.).

import { readFileSync } from "node:fs"
import { error, log } from "node:console"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { buildProject } from "./effect-artifacts/project.mjs"
import {
  STRICT_ZERO_METRICS,
  computeQualityMetrics,
} from "./effect-artifacts/quality-metrics.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "effect-quality-metrics-baseline.json")

const project = buildProject()
const current = computeQualityMetrics(project)

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
const baselineMetrics = baseline.metrics ?? {}

let failures = 0

for (const [key, baselineValue] of Object.entries(baselineMetrics)) {
  const currentValue = current[key]
  if (typeof currentValue !== "number") {
    error(`Unknown metric in baseline: ${key}`)
    failures += 1
    continue
  }

  if (STRICT_ZERO_METRICS.has(key) && baselineValue !== 0) {
    error(
      `Strict-zero metric ${key} has baseline=${baselineValue}; must be 0. Fix the baseline.`,
    )
    failures += 1
    continue
  }

  if (currentValue > baselineValue) {
    error(
      `Effect-quality regression: ${key} current=${currentValue} > baseline=${baselineValue}.`,
    )
    failures += 1
  } else if (currentValue < baselineValue) {
    log(
      `Effect-quality improvement (re-baseline to lock in): ${key} current=${currentValue} < baseline=${baselineValue}. Run pnpm run lint:effect-quality:baseline.`,
    )
  }
}

const baselineKeys = new Set(Object.keys(baselineMetrics))
for (const key of Object.keys(current)) {
  if (!baselineKeys.has(key)) {
    error(`New metric ${key} not present in baseline. Run pnpm run lint:effect-quality:baseline.`)
    failures += 1
  }
}

if (failures > 0) {
  process.exit(1)
}

log("Effect-quality metric ratchet OK.")
for (const [key, value] of Object.entries(current)) {
  log(`  ${key} = ${value} (baseline ${baselineMetrics[key]})`)
}
