#!/usr/bin/env tsx
/**
 * Manual seam-coverage report: `trace:seams [runId]`. With no arg it reports
 * the latest unified-kernel-validation run. The analysis engine lives in
 * runner/seam-coverage.ts; this is just the process entry (exit code = whether
 * any gating production assertion is uncovered).
 */
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { runSeamCoverage } from "../runner/seam-coverage.ts"

const program = Effect.gen(function*() {
  const runId = process.argv[2]
  const summary = yield* runSeamCoverage(runId)
  yield* Effect.sync(() => {
    process.exitCode = summary.gatingProductionFailing > 0 ? 1 : 0
  })
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
