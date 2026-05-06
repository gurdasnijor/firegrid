// firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3
// firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5
// firegrid-remediation-hardening.STATIC_QUALITY.11
//
// Inventory-driven rule layer over the artifact inventory JSON.
//
// Rules implemented:
// 1. workspace-pair-forbidden — re-exports or imports across forbidden
//    workspace pairs (runtime → client, lab → substrate, lab → runtime,
//    runtime → lab, substrate → client/runtime/lab).
// 2. unknown-role-budget — count of `byRole.unknown` exports against
//    a tracked baseline (ratchet, monotonic decrease only).
// 3. cross-workspace-reexport-budget — count of re-exports whose
//    declaration lives in a different workspace than the export, against
//    a tracked baseline.
// 4. effect-returning-export-budget — count of `effect-returning` role
//    artifacts per workspace against a tracked baseline.
//
// Rules deferred (require ts-morph evidence not currently emitted by the
// inventory; tracked in the static-enforcement proposal):
// - service-tag-namespace-hygiene (tag string casing, separator presence)
// - explicit-return-type-visibility for exported Effect-returning fns
// - public-surface allowlist driven by the inventory itself
//
// The rule layer is run by `scripts/effect-artifacts-rules-check.mjs`
// after `arch:effect-artifacts` regenerates the inventory, ensuring the
// gate sees fresh state.

const FORBIDDEN_WORKSPACE_PAIRS = [
  { from: "packages/runtime", to: "packages/client" },
  { from: "packages/client", to: "packages/runtime" },
  { from: "apps/lab", to: "packages/runtime" },
  { from: "apps/lab", to: "packages/substrate" },
  { from: "packages/runtime", to: "apps/lab" },
  { from: "packages/substrate", to: "packages/client" },
  { from: "packages/substrate", to: "packages/runtime" },
  { from: "packages/substrate", to: "apps/lab" },
  { from: "packages/client", to: "apps/lab" },
]

const EFFECT_RETURNING_COMPAT_REEXPORT_PATHS = new Set([
  "packages/substrate/src/retained-records.ts",
  "packages/substrate/src/stream.ts",
])

// firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3
const checkForbiddenWorkspacePairs = (inventory) => {
  const violations = []
  const artifacts = inventory.artifacts ?? []
  for (const artifact of artifacts) {
    const exportWs = artifact.exportLocation?.workspace
    const declarationWs = artifact.declarationLocation?.workspace
    if (
      typeof exportWs !== "string" ||
      typeof declarationWs !== "string" ||
      exportWs === declarationWs
    ) {
      continue
    }
    const forbidden = FORBIDDEN_WORKSPACE_PAIRS.find(
      (pair) => pair.from === exportWs && pair.to === declarationWs,
    )
    if (forbidden !== undefined) {
      violations.push({
        rule: "workspace-pair-forbidden",
        artifact: artifact.exportName,
        from: exportWs,
        to: declarationWs,
        exportPath: artifact.exportLocation?.path,
        declarationPath: artifact.declarationLocation?.path,
      })
    }
  }
  return violations
}

// firegrid-remediation-hardening.STATIC_QUALITY.11
export const computeRuleMetrics = (inventory) => {
  const summary = inventory.summary ?? {}
  const byRole = summary.byRole ?? {}
  const byWorkspace = summary.byWorkspace ?? {}
  const artifacts = inventory.artifacts ?? []

  // Cross-workspace re-export count: artifact whose exportLocation.workspace
  // != declarationLocation.workspace.
  let crossWorkspaceReExports = 0
  const effectReturningPerWorkspace = {}
  for (const artifact of artifacts) {
    const exportWs = artifact.exportLocation?.workspace
    const declarationWs = artifact.declarationLocation?.workspace
    if (
      typeof exportWs === "string" &&
      typeof declarationWs === "string" &&
      exportWs !== declarationWs
    ) {
      crossWorkspaceReExports += 1
    }
    if (artifact.role === "effect-returning") {
      if (
        artifact.isReExport &&
        EFFECT_RETURNING_COMPAT_REEXPORT_PATHS.has(artifact.exportLocation?.path)
      ) {
        continue
      }
      const ws = exportWs ?? "(unknown)"
      effectReturningPerWorkspace[ws] =
        (effectReturningPerWorkspace[ws] ?? 0) + 1
    }
  }

  return {
    unknownRoleCount: byRole.unknown ?? 0,
    crossWorkspaceReExportCount: crossWorkspaceReExports,
    boundaryCrossingCount: summary.boundaryCrossings ?? 0,
    forbiddenLayerCrossingCount: summary.forbiddenLayerCrossings ?? 0,
    effectReturningPerWorkspace,
    totalArtifactCount: summary.totalArtifacts ?? 0,
    workspaceTotals: byWorkspace,
  }
}

// Compares current metrics to baseline. Returns array of violation
// strings. Each metric is monotonically non-increasing (ratchet).
const checkRuleBudgets = (current, baseline) => {
  const violations = []
  const baselineBudgets = baseline?.budgets ?? {}

  const compareScalar = (key) => {
    const baselineValue = baselineBudgets[key]
    const currentValue = current[key]
    if (typeof baselineValue !== "number") {
      violations.push(
        `Missing baseline budget for ${key}; run lint:effect-rules:baseline.`,
      )
      return
    }
    if (currentValue > baselineValue) {
      violations.push(
        `Budget regression: ${key} current=${currentValue} > baseline=${baselineValue}.`,
      )
    }
  }

  compareScalar("unknownRoleCount")
  compareScalar("crossWorkspaceReExportCount")
  compareScalar("boundaryCrossingCount")
  compareScalar("forbiddenLayerCrossingCount")

  // Per-workspace Effect-returning export budget.
  const baselineEffectReturning =
    baselineBudgets.effectReturningPerWorkspace ?? {}
  for (const [ws, count] of Object.entries(current.effectReturningPerWorkspace)) {
    const baselineValue = baselineEffectReturning[ws]
    if (typeof baselineValue !== "number") {
      violations.push(
        `New workspace ${ws} not in effectReturningPerWorkspace baseline; run lint:effect-rules:baseline.`,
      )
      continue
    }
    if (count > baselineValue) {
      violations.push(
        `Effect-returning budget regression: ${ws} current=${count} > baseline=${baselineValue}.`,
      )
    }
  }

  return violations
}

export const runArtifactRules = (inventory, baseline) => {
  const forbiddenPairs = checkForbiddenWorkspacePairs(inventory)
  const metrics = computeRuleMetrics(inventory)
  const budgetViolations = checkRuleBudgets(metrics, baseline)
  return {
    forbiddenPairViolations: forbiddenPairs,
    metrics,
    budgetViolations,
  }
}
