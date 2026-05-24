import { readdir } from "node:fs/promises"
import { Data, Effect } from "effect"
import type { TinyFiregridSimulation } from "../types.ts"

const simulationsUrl = new URL("../simulations/", import.meta.url)

class SimulationFolderInvalid extends Data.TaggedClass("SimulationFolderInvalid")<{
  readonly folder: string
  readonly reason: string
}> {}

class UnknownSimulation extends Data.TaggedClass("UnknownSimulation")<{
  readonly id: string
  readonly available: ReadonlyArray<string>
}> {}

const isSimulation = (
  value: unknown,
): value is TinyFiregridSimulation<unknown> => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate["id"] === "string" &&
    typeof candidate["description"] === "string" &&
    typeof candidate["host"] === "function" &&
    candidate["driver"] !== undefined
}

// Folders that hold scaffolding / not-yet-real simulations. Hidden from
// discovery so they don't show up in `simulate list` or get picked up as
// runnable. Add to this set rather than relying on placeholder `index.ts`
// files that the discovery walk would otherwise happily load.
//
// The shape-c / shape-d / wave-d-a entries below are probe-test-only
// sims (their `index.ts` exports vocabulary used by the sibling
// `test/<sim>/probe.test.ts` but has no `defineSimulation(...)` default
// export). They were never runnable through the standard
// `simulate:run`/`simulate:list` flow and remain probe-only by design.
// Without this hiding the discovery walk fails on the first such
// folder it encounters, which previously masked the consumer-retarget
// breakage that PR #738's host-sdk deletion would have exposed and now
// surfaces during `simulate list`.
const hiddenFolders = new Set([
  "sim2-multi-surface-projection",
  "shape-c-channel-router-turn",
  "shape-c-non-recursive-start",
  "shape-c-terminal-ordering",
  "shape-d-tool-dispatch-mcp-entry",
  "wave-d-a-shape-b-input-identity-dedup",
])

const isHidden = (folder: string): boolean =>
  hiddenFolders.has(folder) || folder.startsWith("_") || folder.startsWith(".")

export const listSimulations = Effect.gen(function*() {
  const candidates = yield* discoverSimulationCandidates(simulationsUrl)

  return yield* Effect.forEach(candidates, candidate =>
    Effect.gen(function*() {
      const module = yield* Effect.promise(
        () => import(candidate.moduleUrl.href) as Promise<{ readonly default?: unknown }>,
      )
      if (!isSimulation(module.default)) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: candidate.folder,
          reason: "missing default export of simulation shape",
        }))
      }
      if (module.default.id !== candidate.directory) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: candidate.folder,
          reason: `id ${module.default.id} does not match folder`,
        }))
      }
      return module.default
    }))
})

interface SimulationCandidate {
  readonly directory: string
  readonly folder: string
  readonly moduleUrl: URL
}

const discoverSimulationCandidates = (
  directoryUrl: URL,
  parts: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyArray<SimulationCandidate>> =>
  Effect.gen(function*() {
    const entries = yield* Effect.promise(() =>
      readdir(directoryUrl, { withFileTypes: true }),
    )
    const visibleDirectories = entries
      .filter(entry => entry.isDirectory() && !isHidden(entry.name))
      .map(entry => entry.name)
      .sort()
    const hasIndex = entries.some(entry => entry.isFile() && entry.name === "index.ts")
    const current = hasIndex && parts.length > 0
      ? [{
        directory: parts[parts.length - 1] ?? "",
        folder: parts.join("/"),
        moduleUrl: new URL("index.ts", directoryUrl),
      }]
      : []
    const nested = yield* Effect.forEach(visibleDirectories, directory =>
      discoverSimulationCandidates(
        new URL(`${directory}/`, directoryUrl),
        [...parts, directory],
      ), { concurrency: "unbounded" })

    return current.concat(nested.flat())
  })

// Resolve a simulation by id; on miss, fail with the available ids so the
// CLI error message lists them. There is no "default simulation" — running
// without an explicit id must error rather than silently picking the
// alphabetically-first folder. Implicit defaults in dev tooling cause
// exactly the "wait, why did it run that one" confusion the runner is
// supposed to prevent.
export const selectedSimulation = (
  simulationId: string,
): Effect.Effect<
  TinyFiregridSimulation<unknown>,
  SimulationFolderInvalid | UnknownSimulation
> =>
  Effect.flatMap(listSimulations, simulations => {
    const simulation = simulations.find(s => s.id === simulationId)
    return simulation === undefined
      ? Effect.fail(new UnknownSimulation({
        id: simulationId,
        available: simulations.map(s => s.id),
      }))
      : Effect.succeed(simulation)
  })
