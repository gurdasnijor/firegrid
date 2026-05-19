import { codexAcpToolCallSimulation } from "./codex-acp-tool-call-pipeline.ts"
import { darkFactoryPipelineSimulation } from "./dark-factory-pipeline.ts"
import { stdioJsonlToolExecutionSimulation } from "./stdio-jsonl-tool-execution-pipeline.ts"
import type { TinyFiregridSimulation } from "./types.ts"
import { waitForOutputSimulation } from "./wait-for-output-pipeline.ts"

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

export const tinyFiregridSimulations = [
  eraseSimulationResult(codexAcpToolCallSimulation),
  eraseSimulationResult(waitForOutputSimulation),
  eraseSimulationResult(darkFactoryPipelineSimulation),
  eraseSimulationResult(stdioJsonlToolExecutionSimulation),
] as const satisfies ReadonlyArray<TinyFiregridSimulation<unknown>>

export type TinyFiregridSimulationId = typeof tinyFiregridSimulations[number]["id"]

export const findTinyFiregridSimulation = (
  id: string,
): TinyFiregridSimulation<unknown> | undefined =>
  tinyFiregridSimulations.find(simulation => simulation.id === id)
