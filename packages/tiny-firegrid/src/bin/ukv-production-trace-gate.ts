#!/usr/bin/env tsx
/**
 * The unified-kernel-validation production trace gate (`trace:seams:ukv`).
 *
 * The sim remains evidence-producing; this entry runs it, then checks the
 * emitted OTel trace for host/substrate spans that a driver cannot forge. The
 * check runs in-process via runner/seam-coverage.ts (no subprocess hop, no raw
 * node: I/O — the latest-run lookup is delegated to the runner's trace.ts).
 */
import { Command } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { runSeamCoverage } from "../runner/seam-coverage.ts"

const runSimulation = Command.make(
  "pnpm",
  "run",
  "simulate:run",
  "unified-kernel-validation",
).pipe(
  Command.stdout("inherit"),
  Command.stderr("inherit"),
  Command.exitCode,
  Effect.map(exitCode => Number(exitCode)),
)

const program = Effect.gen(function*() {
  yield* Console.log("Running unified-kernel-validation sim before trace gate...")
  const simStatus = yield* runSimulation
  if (simStatus !== 0) {
    yield* Effect.sync(() => {
      process.exitCode = simStatus
    })
    return
  }

  yield* Console.log("Checking UKV production trace (latest unified-kernel-validation run)...")
  const summary = yield* runSeamCoverage(undefined)
  yield* Effect.sync(() => {
    process.exitCode = summary.gatingProductionFailing > 0 ? 1 : 0
  })
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
