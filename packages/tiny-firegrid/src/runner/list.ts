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
const hiddenFolders = new Set(["to-be-migrated"])

const isHidden = (folder: string): boolean =>
  hiddenFolders.has(folder) || folder.startsWith("_") || folder.startsWith(".")

interface SimulationModuleRef {
  readonly folder: string
  readonly moduleUrl: URL
}

const discoverSimulationModules = (
  root: URL,
  segments: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyArray<SimulationModuleRef>> =>
  Effect.gen(function*() {
    const entries = yield* Effect.promise(() =>
      readdir(root, { withFileTypes: true }),
    )
    const hasIndex = entries.some(entry => entry.isFile() && entry.name === "index.ts")
    if (hasIndex) {
      return [{
        folder: segments.at(-1) ?? "",
        moduleUrl: new URL("index.ts", root),
      }]
    }
    const directories = entries
      .filter(entry => entry.isDirectory() && !isHidden(entry.name))
      .map(entry => entry.name)
      .sort()
    const nested = yield* Effect.forEach(directories, directory =>
      discoverSimulationModules(
        new URL(`${directory}/`, root),
        [...segments, directory],
      ))
    return nested.flat()
  })

export const listSimulations = Effect.gen(function*() {
  const modules = yield* discoverSimulationModules(simulationsUrl)

  return yield* Effect.forEach(modules, moduleRef =>
    Effect.gen(function*() {
      const module = yield* Effect.promise(
        () => import(moduleRef.moduleUrl.href) as Promise<{ readonly default?: unknown }>,
      )
      if (!isSimulation(module.default)) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: moduleRef.folder,
          reason: "missing default export of simulation shape",
        }))
      }
      if (module.default.id !== moduleRef.folder) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: moduleRef.folder,
          reason: `id ${module.default.id} does not match folder`,
        }))
      }
      return module.default
    }))
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
