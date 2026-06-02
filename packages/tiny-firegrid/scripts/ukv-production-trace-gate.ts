#!/usr/bin/env tsx
/**
 * CI wrapper for the unified-kernel-validation production trace gate.
 *
 * The sim remains evidence-producing; this script runs it, then checks the
 * emitted OTel trace for host/substrate spans that a driver cannot forge.
 */

import { Command } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const runsRoot = join(process.cwd(), ".simulate/runs")

const latestUnifiedKernelValidationRun = (): string => {
  const entries = readdirSync(runsRoot)
    .filter((name) => name.includes("unified-kernel-validation"))
    .map((name) => ({
      name,
      mtime: statSync(join(runsRoot, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)

  if (entries.length === 0) {
    throw new Error(`no unified-kernel-validation runs found in ${runsRoot}`)
  }

  return entries[0]!.name
}

const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
) =>
  Command.make(command, ...args).pipe(
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.map((exitCode) => Number(exitCode)),
  )

const program = Effect.gen(function*() {
  yield* Console.log("Running unified-kernel-validation sim before trace gate...")
  const simStatus = yield* runCommand("pnpm", [
    "run",
    "simulate:run",
    "unified-kernel-validation",
  ])

  if (simStatus !== 0) {
    yield* Effect.sync(() => {
      process.exitCode = simStatus
    })
    return
  }

  const runId = yield* Effect.sync(latestUnifiedKernelValidationRun)
  yield* Console.log(`Checking UKV production trace for run ${runId}...`)
  const traceStatus = yield* runCommand("pnpm", ["-w", "trace:seams", runId])
  yield* Effect.sync(() => {
    process.exitCode = traceStatus
  })
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
