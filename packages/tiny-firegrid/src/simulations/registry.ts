import { readdirSync } from "node:fs"
import type { TinyFiregridSimulation } from "./types.ts"

// Auto-discovery registry.
//
// Every simulation lives in its own `src/simulations/<name>.ts` file and
// `export`s a const that satisfies `TinyFiregridSimulation<A>`. This module
// scans the directory at load time and collects every such export. Adding a
// simulation is therefore "add a file" — it never edits this (or any other)
// shared file, so parallel fan-out builds cannot collide on a registry array.

const eraseSimulationResult = <A>(
  simulation: TinyFiregridSimulation<A>,
): TinyFiregridSimulation<unknown> => ({
  id: simulation.id,
  description: simulation.description,
  makeHost: simulation.makeHost,
  driver: simulation.driver,
  summarize: result => simulation.summarize(result as A),
  ...(simulation.localize === undefined
    ? {}
    : { localize: result => simulation.localize?.(result as A) ?? [] }),
})

// Files in src/simulations/ that are infrastructure, not simulations.
const NON_SIMULATION_FILES = new Set([
  "registry.ts",
  "types.ts",
  "trace-artifacts.ts",
  "trace-recorder.ts",
])

const isSimulation = (value: unknown): value is TinyFiregridSimulation<unknown> => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.makeHost === "function" &&
    typeof candidate.driver === "function" &&
    typeof candidate.summarize === "function"
  )
}

// Accepted bin-only escape hatch: this is a CLI/simulation-runner discovery
// loader, not durable runtime code. The cache is a one-shot process-lifetime
// memo of a filesystem scan — there is no durable state to derive from
// Durable Streams here.
// eslint-disable-next-line local/no-module-durable-cache
let cache: ReadonlyArray<TinyFiregridSimulation<unknown>> | undefined

export const loadTinyFiregridSimulations = async (): Promise<
  ReadonlyArray<TinyFiregridSimulation<unknown>>
> => {
  if (cache !== undefined) return cache

  const files = readdirSync(new URL(".", import.meta.url))
    .filter(file => file.endsWith(".ts") && !NON_SIMULATION_FILES.has(file))
    .sort()

  const modules = await Promise.all(
    files.map(
      file =>
        import(new URL(file, import.meta.url).href) as Promise<
          Record<string, unknown>
        >,
    ),
  )

  const found = modules.flatMap((moduleNamespace, index) =>
    Object.values(moduleNamespace)
      .filter(isSimulation)
      .map(simulation => ({
        file: files[index] ?? "",
        sim: eraseSimulationResult(simulation),
      })),
  )

  const duplicate = found.find(
    (entry, index) =>
      found.findIndex(other => other.sim.id === entry.sim.id) !== index,
  )
  if (duplicate !== undefined) {
    return Promise.reject(
      new Error(
        `duplicate tiny-firegrid simulation id "${duplicate.sim.id}" ` +
          `(check ${duplicate.file} against an earlier file)`,
      ),
    )
  }

  cache = found
    .map(entry => entry.sim)
    .sort((a, b) => a.id.localeCompare(b.id))
  return cache
}

// Returns the discovered set. Callers (the CLI in src/bin/simulate.ts) always
// `await loadTinyFiregridSimulations()` before using this, so an empty list
// here only ever means "load not awaited yet" — not a runtime error path.
export const tinyFiregridSimulationList = (): ReadonlyArray<
  TinyFiregridSimulation<unknown>
> => cache ?? []

export type TinyFiregridSimulationId = string

export const findTinyFiregridSimulation = (
  id: string,
): TinyFiregridSimulation<unknown> | undefined =>
  tinyFiregridSimulationList().find(simulation => simulation.id === id)
