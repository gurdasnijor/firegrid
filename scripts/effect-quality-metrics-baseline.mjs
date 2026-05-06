// firegrid-remediation-hardening.STATIC_QUALITY.11
//
// Recomputes Effect-quality metric baseline using the AST-precise
// ts-morph counter. Refuses to ratchet upward without an explicit edit
// (mirrors the jscpd/knip baseline scripts).

import { readFileSync, writeFileSync } from "node:fs"
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

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
} catch {
  baseline = { metrics: {} }
}

const project = buildProject()
const current = computeQualityMetrics(project)
const previous = baseline.metrics ?? {}

let refusals = 0

for (const [key, currentValue] of Object.entries(current)) {
  if (STRICT_ZERO_METRICS.has(key) && currentValue !== 0) {
    error(
      `Strict-zero metric ${key} would ratchet to ${currentValue}; must remain 0.`,
    )
    refusals += 1
    continue
  }
  const previousValue = previous[key]
  if (typeof previousValue === "number" && currentValue > previousValue) {
    error(
      `Refusing to ratchet up: ${key} current=${currentValue} > previous=${previousValue}. Fix the regression first.`,
    )
    refusals += 1
  }
}

if (refusals > 0) {
  process.exit(1)
}

const next = {
  metrics: current,
}
writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
log("Effect-quality metric baseline updated:")
for (const [key, value] of Object.entries(current)) {
  log(`  ${key} = ${value}`)
}
