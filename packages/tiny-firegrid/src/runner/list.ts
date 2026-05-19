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

export const listSimulations = Effect.gen(function*() {
  const entries = yield* Effect.promise(() =>
    readdir(simulationsUrl, { withFileTypes: true }),
  )
  const directories = entries
    .filter(entry => entry.isDirectory() && !isHidden(entry.name))
    .map(entry => entry.name)
    .sort()

  return yield* Effect.forEach(directories, directory =>
    Effect.gen(function*() {
      const moduleUrl = new URL(`${directory}/index.ts`, simulationsUrl)
      const module = yield* Effect.promise(
        () => import(moduleUrl.href) as Promise<{ readonly default?: unknown }>,
      )
      if (!isSimulation(module.default)) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: directory,
          reason: "missing default export of simulation shape",
        }))
      }
      if (module.default.id !== directory) {
        return yield* Effect.fail(new SimulationFolderInvalid({
          folder: directory,
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
