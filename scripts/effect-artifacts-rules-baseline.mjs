// firegrid-remediation-hardening.STATIC_QUALITY.11
//
// Recomputes effect-artifact rule baseline. Refuses to ratchet upward.

import { readFileSync, writeFileSync } from "node:fs"
import { error, log } from "node:console"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { analyzeProject } from "./effect-artifacts/analyze.mjs"
import { buildProject } from "./effect-artifacts/project.mjs"
import { computeRuleMetrics } from "./effect-artifacts/rules.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "effect-artifact-rules-baseline.json")

const project = buildProject()
const inventory = analyzeProject(project)
const metrics = computeRuleMetrics(inventory)

let previous
try {
  previous = JSON.parse(readFileSync(baselinePath, "utf8"))
} catch {
  previous = { budgets: {} }
}

const previousBudgets = previous.budgets ?? {}

const compareScalar = (key) => {
  const prev = previousBudgets[key]
  const next = metrics[key]
  if (typeof prev === "number" && next > prev) {
    error(
      `Refusing to ratchet up: ${key} current=${next} > previous=${prev}. Fix the regression first.`,
    )
    return false
  }
  return true
}

let refusals = 0
for (const key of [
  "unknownRoleCount",
  "crossWorkspaceReExportCount",
  "boundaryCrossingCount",
  "forbiddenLayerCrossingCount",
]) {
  if (!compareScalar(key)) refusals += 1
}

const previousEffectReturning =
  previousBudgets.effectReturningPerWorkspace ?? {}
for (const [ws, count] of Object.entries(metrics.effectReturningPerWorkspace)) {
  const prev = previousEffectReturning[ws]
  if (typeof prev === "number" && count > prev) {
    error(
      `Refusing to ratchet up: effectReturningPerWorkspace[${ws}] current=${count} > previous=${prev}.`,
    )
    refusals += 1
  }
}

if (refusals > 0) {
  process.exit(1)
}

const next = {
  budgets: {
    unknownRoleCount: metrics.unknownRoleCount,
    crossWorkspaceReExportCount: metrics.crossWorkspaceReExportCount,
    boundaryCrossingCount: metrics.boundaryCrossingCount,
    forbiddenLayerCrossingCount: metrics.forbiddenLayerCrossingCount,
    effectReturningPerWorkspace: metrics.effectReturningPerWorkspace,
  },
}
writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
log("Effect-artifact rules baseline updated.")
