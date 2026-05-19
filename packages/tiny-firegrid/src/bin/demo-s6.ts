// demo:s6 — one-command §6 dark-factory demo.
//
// Runs the dark-factory-pipeline §6 simulation, then renders the latest run
// through `simulate proof` (the merged #402 readout) so whoever presents the
// demo runs ONE command and gets the copy-pasteable objective §6 proof
// matrix.
//
// It does NOT bake in a quota key: ANTHROPIC_API_KEY is supplied by the
// runner environment and consumed by the dark-factory driver. It never
// fakes: if the simulation cannot run, or the run produced no §6 proof
// summary, it prints the exact reason and exits non-zero.

import { spawnSync } from "node:child_process"
import path from "node:path"

const simulateBin = path.join(import.meta.dirname, "simulate.ts")

const hr = "─".repeat(72)

const banner = (): void => {
  const keyPresent =
    typeof globalThis.process.env.ANTHROPIC_API_KEY === "string" &&
    globalThis.process.env.ANTHROPIC_API_KEY.length > 0
  console.log(hr)
  console.log("Firegrid §6 Dark-Factory demo  ·  pnpm demo:s6")
  console.log(
    "ANTHROPIC_API_KEY: " +
      (keyPresent
        ? "supplied by runner environment (not baked into this script)"
        : "NOT set — the §6 run will fail fast with the authoritative reason"),
  )
  console.log(
    "Flow: run dark-factory-pipeline  →  render latest via `simulate proof`",
  )
  console.log(hr)
}

const runStep = (
  label: string,
  args: ReadonlyArray<string>,
): number => {
  console.log(`\n[demo:s6] ${label}: tsx simulate ${args.join(" ")}\n`)
  const result = spawnSync(
    "tsx",
    [simulateBin, ...args],
    { stdio: "inherit", env: globalThis.process.env },
  )
  if (result.error !== undefined) {
    console.error(`[demo:s6] failed to spawn ${label}: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

const main = (): void => {
  banner()

  const runStatus = runStep("§6 run", [
    "run",
    "--",
    "dark-factory-pipeline",
  ])
  if (runStatus !== 0) {
    console.error(hr)
    console.error(
      `[demo:s6] the §6 simulation did not complete (exit ${runStatus}).`,
    )
    console.error(
      "[demo:s6] not rendering a proof — there is no completed run to read.",
    )
    console.error(
      "[demo:s6] re-run with a valid ANTHROPIC_API_KEY in the environment.",
    )
    console.error(hr)
    globalThis.process.exitCode = runStatus
    return
  }

  const proofStatus = runStep("§6 proof", ["proof", "--", "latest"])
  if (proofStatus !== 0) {
    console.error(hr)
    console.error(
      `[demo:s6] the latest run produced no §6 proof summary (exit ${proofStatus}).`,
    )
    console.error(
      "[demo:s6] the reason is printed above; nothing was faked.",
    )
    console.error(hr)
    globalThis.process.exitCode = proofStatus
    return
  }

  console.log(`\n${hr}`)
  console.log(
    "[demo:s6] done — the §6 proof matrix above is copy-pasteable into the demo/PR.",
  )
  console.log(hr)
}

main()
