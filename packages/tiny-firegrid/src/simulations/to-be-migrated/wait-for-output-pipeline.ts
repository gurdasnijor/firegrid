/* eslint-disable */
import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { tinyOutputJournalPipeline } from "../configurations/output-journal-pipeline.ts"
import { tinyWaitForOutputPipeline } from "../configurations/wait-for-output-pipeline.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"

type WaitForOutputSimulationResult =
  typeof tinyWaitForOutputPipeline extends Effect.Effect<infer A, infer _E, infer _R> ? A
    : never

const waitForOutputDriver = (
  _env: TinyFiregridSimulationEnv,
): Effect.Effect<WaitForOutputSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    yield* Firegrid
     
    return yield* tinyWaitForOutputPipeline
  })

export const waitForOutputSimulation = {
  id: "wait-for-output-pipeline",
  description:
    "Deterministically checks that typed wait_for AgentOutput sources resolve against the correct per-context durable output stream.",
  makeHost: env =>
     
    tinyOutputJournalPipeline({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      localProcessEnv: env.localProcessEnv,
    }),
  driver: waitForOutputDriver,
} satisfies TinyFiregridSimulation<WaitForOutputSimulationResult>
