#!/usr/bin/env tsx
/**
 * tf-r06u.24 R1 — tiny-firegrid/src LAYOUT ALLOWLIST (standing regression gate).
 *
 * tiny-firegrid/src must contain ONLY the methodology-sanctioned tiers. This
 * kills ad-hoc tiers like the retired `prototypes/` (tf-r06u.25): the gate goes
 * RED the moment anyone re-adds a top-level entry outside the allowlist, so a
 * private-seam spike can't sneak back in under a new directory name.
 *
 * Pairs with the dep-cruiser airgap rules (R2 sims, R3 tests) and the eslint
 * no-standalone-script rule (R4); together they enforce the methodology's
 * "a sim is a folder under simulations/<id>/ with a client-sdk driver +
 * host(env) composition" contract structurally rather than by review.
 *
 * Effect-native (FileSystem/Path); paths resolved off this module's URL so it
 * stays correct regardless of cwd.
 */
import { FileSystem, Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"

// The only top-level entries permitted under tiny-firegrid/src.
//   simulations/  — the sims (driver + host(env) + probe + FINDING)
//   runner/       — the simulate CLI runner (trace/perf/list/gate)
//   experiment/   — the experiment harness (experiment* per methodology)
//   bin/          — spawn-target binaries + CLI/gate entries
//   index.ts / types.ts — CLI entry + shared types.
const allowedEntries = new Set([
  "simulations",
  "runner",
  "experiment",
  "bin",
  "index.ts",
  "types.ts",
])
const requiredSimulationFiles = ["index.ts", "driver.ts", "host.ts"] as const
const isRequiredSimulationFile = (name: string): boolean =>
  (requiredSimulationFiles as ReadonlyArray<string>).includes(name)

// Display prefix for failure messages (the fs reads use the resolved abs path).
const displaySrc = "packages/tiny-firegrid/src"
const srcRootUrl = new URL("../", import.meta.url)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tinySrc = yield* path.fromFileUrl(srcRootUrl)
  const simulationsDir = path.join(tinySrc, "simulations")

  // Top-level tiers must be on the allowlist (`.DS_Store` and any `experiment*`
  // sibling are tolerated). Pure name-filtering — no stat needed.
  const topLevelFailures = (yield* fs.readDirectory(tinySrc))
    .filter(name =>
      name !== ".DS_Store" && !name.startsWith("experiment") && !allowedEntries.has(name))
    .map(name =>
      `${displaySrc}/${name}: not an allowed tiny-firegrid/src tier. `
        + "Allowed: simulations/, runner/, experiment*, bin/, index.ts, types.ts. "
        + "(Spikes that drive a private codec/sandbox seam belong in the owning "
        + "package's test/ folder — see docs/findings/tf-r06u-25-tiny-firegrid-asset-inventory.md.)")

  // Each sim folder must be exactly {index.ts, driver.ts, host.ts}.
  const simulationNames = (yield* fs.readDirectory(simulationsDir))
    .filter(name => !name.startsWith(".") && !name.startsWith("_"))
  const simulationFailures = yield* Effect.forEach(simulationNames, simulationName =>
    Effect.gen(function*() {
      const simulationPath = path.join(simulationsDir, simulationName)
      const stat = yield* fs.stat(simulationPath)
      if (stat.type !== "Directory") return [] as ReadonlyArray<string>

      const simulationFiles = yield* fs.readDirectory(simulationPath)
      const unexpected = (yield* Effect.forEach(
        simulationFiles.filter(fileName => fileName !== ".DS_Store"),
        fileName =>
          Effect.map(fs.stat(path.join(simulationPath, fileName)), fileStat =>
            fileStat.type === "File" && isRequiredSimulationFile(fileName)
              ? ""
              : `${displaySrc}/simulations/${simulationName}/${fileName}: simulations must be exactly `
                + "{index.ts, driver.ts, host.ts}; move prose findings to docs/findings/ "
                + "and substrate/scenario/probe code into host.ts or the owning package."),
      )).filter(message => message.length > 0)
      const missing = requiredSimulationFiles
        .filter(required => !simulationFiles.includes(required))
        .map(required =>
          `${displaySrc}/simulations/${simulationName}: missing required simulation file ${required}`)
      return [...unexpected, ...missing]
    }))

  const failures = [...topLevelFailures, ...simulationFailures.flat()]

  if (failures.length > 0) {
    yield* Console.error("tiny-firegrid layout check failed:")
    yield* Effect.forEach(failures, failure => Console.error(`- ${failure}`))
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
    return
  }

  yield* Console.log("tiny-firegrid layout check OK")
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
