import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { tinyOutputJournalPipeline } from "../configurations/output-journal-pipeline.ts"
import { tinyWaitForOutputPipeline } from "../configurations/wait-for-output-pipeline.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"

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
  summarize: result => ({
    // firegrid-typed-wait-source-redesign.SIMULATION.1
    claimStatus: result.claimStatus,
    claims: result.claims.map(claim => ({
      name: claim.name,
      status: claim.status,
      selectedTarget: claim.target,
      expectedTarget: claim.expectedTarget,
      matched: claim.matched,
      matchedContextId: claim.matchedContextId,
      matchedSequence: claim.matchedSequence,
    })),
    // firegrid-typed-wait-source-redesign.SIMULATION.2
    findings: result.findings,
  }),
  localize: result =>
    result.claimStatus === "passed"
      ? [
        "Both AgentOutputAfter and non-After AgentOutput selected the expected per-context durable output stream.",
      ]
      : result.findings.map(finding => finding.summary),
} satisfies TinyFiregridSimulation<WaitForOutputSimulationResult>

