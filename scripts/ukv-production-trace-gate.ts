#!/usr/bin/env tsx
/**
 * CI wrapper for the unified-kernel-validation production trace gate.
 *
 * The sim remains evidence-producing; this script runs it, then checks the
 * emitted OTel trace for host/substrate spans that a driver cannot forge.
 */

import { spawnSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

const runsRoot = join(
  process.cwd(),
  "packages/tiny-firegrid/.simulate/runs",
)

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

const run = (
  command: string,
  args: ReadonlyArray<string>,
): number => {
  const result = spawnSync(command, [...args], {
    stdio: "inherit",
    env: process.env,
  })

  if (result.error !== undefined) {
    console.error(`${command} failed to start: ${result.error.message}`)
    return 1
  }

  return result.status ?? 1
}

console.log("Running unified-kernel-validation sim before trace gate...")
const simStatus = run("pnpm", [
  "--filter",
  "@firegrid/tiny-firegrid",
  "simulate:run",
  "unified-kernel-validation",
])

if (simStatus !== 0) {
  process.exit(simStatus)
}

const runId = latestUnifiedKernelValidationRun()
console.log(`Checking UKV production trace for run ${runId}...`)

const traceStatus = run("pnpm", ["trace:seams", runId])
process.exit(traceStatus)
