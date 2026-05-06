// firegrid-remediation-hardening.STATIC_QUALITY.11
// firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3
//
// Inventory-driven rule check: regenerates the artifact inventory,
// then runs rule-layer checks (forbidden workspace pairs + budgets)
// against the committed baseline. Mirrors the jscpd/knip/effect-quality
// ratchet shape.

import { readFileSync } from "node:fs"
import { error, log } from "node:console"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { analyzeProject } from "./effect-artifacts/analyze.mjs"
import { buildProject } from "./effect-artifacts/project.mjs"
import { runArtifactRules } from "./effect-artifacts/rules.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "effect-artifact-rules-baseline.json")

const project = buildProject()
const inventory = analyzeProject(project)

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
} catch {
  error(
    `Missing or unreadable baseline at ${baselinePath}; run pnpm run lint:effect-rules:baseline.`,
  )
  process.exit(1)
}

const result = runArtifactRules(inventory, baseline)

let failures = 0

if (result.forbiddenPairViolations.length > 0) {
  error("Forbidden workspace-pair violations:")
  for (const v of result.forbiddenPairViolations) {
    error(
      `  ${v.artifact}: ${v.from} → ${v.to} (${v.exportPath} re-exports from ${v.declarationPath})`,
    )
  }
  failures += result.forbiddenPairViolations.length
}

if (result.budgetViolations.length > 0) {
  error("Effect-artifact rule budget violations:")
  for (const msg of result.budgetViolations) {
    error(`  ${msg}`)
  }
  failures += result.budgetViolations.length
}

if (failures > 0) {
  process.exit(1)
}

log("Effect-artifact rules OK.")
log(`  totalArtifacts = ${result.metrics.totalArtifactCount}`)
log(`  unknownRoleCount = ${result.metrics.unknownRoleCount}`)
log(`  crossWorkspaceReExportCount = ${result.metrics.crossWorkspaceReExportCount}`)
log(`  boundaryCrossingCount = ${result.metrics.boundaryCrossingCount}`)
log(`  forbiddenLayerCrossingCount = ${result.metrics.forbiddenLayerCrossingCount}`)
log("  effectReturningPerWorkspace:")
for (const [ws, count] of Object.entries(result.metrics.effectReturningPerWorkspace)) {
  log(`    ${ws} = ${count}`)
}
