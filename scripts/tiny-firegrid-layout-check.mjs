import { error, log } from "node:console"
import { readdirSync } from "node:fs"
import process from "node:process"

// tf-r06u.24 R1 — tiny-firegrid/src LAYOUT ALLOWLIST (standing regression gate).
//
// tiny-firegrid/src must contain ONLY the methodology-sanctioned tiers. This
// kills ad-hoc tiers like the retired `prototypes/` (tf-r06u.25): CI goes RED
// the moment anyone re-adds a top-level entry outside the allowlist, so a
// private-seam spike can't sneak back in under a new directory name.
//
// Pairs with the dep-cruiser airgap rules (R2 sims, R3 tests) and the eslint
// no-standalone-script rule (R4); together they enforce the methodology's
// "a sim is a folder under simulations/<id>/ with a client-sdk driver +
// host(env) composition" contract structurally rather than by review.

const tinySrc = "packages/tiny-firegrid/src"
const simulationsDir = `${tinySrc}/simulations`

// The only top-level entries permitted under tiny-firegrid/src.
//   simulations/  — the sims (driver + host(env) + probe + FINDING)
//   runner/       — the simulate CLI runner (trace/perf/list/gate)
//   experiment/   — the experiment harness (experiment* per methodology)
//   bin/          — spawn-target binaries referenced by live sims
//                   (e.g. fake-acp-agent-process.ts); a real, used tier,
//                   NOT drift — explicitly allowed.
//   index.ts / types.ts — CLI entry + shared types.
const allowedEntries = new Set([
  "simulations",
  "runner",
  "experiment",
  "bin",
  "index.ts",
  "types.ts",
])

const failures = []

let entries
try {
  entries = readdirSync(tinySrc, { withFileTypes: true })
} catch (cause) {
  error(`tiny-firegrid layout check failed: cannot read ${tinySrc}: ${String(cause)}`)
  process.exit(1)
}

for (const entry of entries) {
  const name = entry.name
  if (name === ".DS_Store") continue
  // Allow `experiment` and any `experiment*` sibling (methodology wording).
  if (name.startsWith("experiment")) continue
  if (allowedEntries.has(name)) continue
  failures.push(
    `${tinySrc}/${name}: not an allowed tiny-firegrid/src tier. `
    + `Allowed: simulations/, runner/, experiment*, bin/, index.ts, types.ts. `
    + `(Spikes that drive a private codec/sandbox seam belong in the owning `
    + `package's test/ folder — see docs/findings/tf-r06u-25-tiny-firegrid-asset-inventory.md.)`,
  )
}

let simulationEntries
try {
  simulationEntries = readdirSync(simulationsDir, { withFileTypes: true })
} catch (cause) {
  error(`tiny-firegrid layout check failed: cannot read ${simulationsDir}: ${String(cause)}`)
  process.exit(1)
}

const requiredSimulationFiles = new Set(["index.ts", "driver.ts", "host.ts"])

for (const simulationEntry of simulationEntries) {
  if (!simulationEntry.isDirectory()) continue
  const simulationName = simulationEntry.name
  if (simulationName.startsWith(".") || simulationName.startsWith("_")) continue

  const simulationPath = `${simulationsDir}/${simulationName}`
  const simulationFiles = readdirSync(simulationPath, { withFileTypes: true })
  for (const simulationFile of simulationFiles) {
    const fileName = simulationFile.name
    if (fileName === ".DS_Store") continue
    failures.push(
      simulationFile.isFile() && requiredSimulationFiles.has(fileName)
        ? ""
        : `${simulationPath}/${fileName}: simulations must be exactly `
          + `{index.ts, driver.ts, host.ts}; move prose findings to docs/findings/ `
          + `and substrate/scenario/probe code into host.ts or the owning package.`,
    )
  }

  for (const required of requiredSimulationFiles) {
    if (!simulationFiles.some(file => file.isFile() && file.name === required)) {
      failures.push(`${simulationPath}: missing required simulation file ${required}`)
    }
  }
}

for (let i = failures.length - 1; i >= 0; i--) {
  if (failures[i] === "") failures.splice(i, 1)
}

if (failures.length > 0) {
  error("tiny-firegrid layout check failed:")
  for (const failure of failures) error(`- ${failure}`)
  process.exit(1)
}

log("tiny-firegrid layout check OK")
