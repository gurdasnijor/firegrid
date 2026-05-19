import { readdir } from "node:fs/promises"
import { Data, Effect, Option } from "effect"
import type { TinyFiregridSimulation } from "../types.ts"

const simulationsUrl = new URL("../simulations/", import.meta.url)

class SimulationFolderInvalid extends Data.TaggedClass("SimulationFolderInvalid")<{
  readonly folder: string
  readonly reason: string
}> {}

class UnknownSimulation extends Data.TaggedClass("UnknownSimulation")<{
  readonly id: string
}> {}

class NoSimulations extends Data.TaggedClass("NoSimulations") {}

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

export const listSimulations = Effect.gen(function*() {
  const entries = yield* Effect.promise(() =>
    readdir(simulationsUrl, { withFileTypes: true }),
  )
  const directories = entries
    .filter(entry => entry.isDirectory())
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

const findSimulation = (id: string) =>
  Effect.flatMap(listSimulations, simulations => {
    const simulation = simulations.find(simulation => simulation.id === id)
    return simulation === undefined
      ? Effect.fail(new UnknownSimulation({ id }))
      : Effect.succeed(simulation)
  })

const firstSimulation = Effect.flatMap(listSimulations, simulations =>
  simulations[0] === undefined
    ? Effect.fail(new NoSimulations())
    : Effect.succeed(simulations[0]),
)

export const selectedSimulation = (
  simulationId: Option.Option<string>,
): Effect.Effect<
  TinyFiregridSimulation<unknown>,
  SimulationFolderInvalid | NoSimulations | UnknownSimulation
> =>
  Option.isNone(simulationId)
    ? firstSimulation
    : findSimulation(simulationId.value)
