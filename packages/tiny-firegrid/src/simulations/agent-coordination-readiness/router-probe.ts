// Supplementary readiness probe — full driver including step 5b strict
// `HostPlaneChannelRouter.dispatch` assertion. Lives OUTSIDE
// `driver.ts` on purpose: the
// `packages/tiny-firegrid/src/simulations/*/driver.ts` ESLint scope
// forbids reaching past `@firegrid/client-sdk` (drivers consume only
// the public client surface). Step 5b's job is precisely to assert the
// router-mediated path independent of client-sdk, so it cannot live in
// `driver.ts` without widening the boundary rule. Keeping it here
// preserves the lint contract.
//
// Consumers:
//   - `test/agent-coordination-readiness/smoke.test.ts` (vitest probe).
//
// NOT consumed by the standard `TinyFiregridSimulation.driver` slot —
// `index.ts` wires the client-only driver from `./driver.ts`.

import type { Firegrid } from "@firegrid/client-sdk/firegrid"
import { SessionAgentOutputChannelTarget } from "@firegrid/protocol/channels"
import { type RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { HostPlaneChannelRouter } from "@firegrid/runtime/channels"
import { Effect } from "effect"
import type { AgentCoordinationReadinessClientResult } from "./driver.ts"
import { runAgentCoordinationReadinessSmokeViaClient } from "./driver.ts"

export interface AgentCoordinationReadinessResult
  extends AgentCoordinationReadinessClientResult {
  readonly observedViaRouter: RuntimeAgentOutputObservation
}

/**
 * Full readiness driver — R = `Firegrid | HostPlaneChannelRouter`.
 * Wraps the client-only driver and adds the step-5b strict assertion
 * (direct router-mediated `wait_for` on `session.agent_output`,
 * returning the same `sequence` as 5a).
 */
export const runAgentCoordinationReadinessSmoke = (
  runId: string,
): Effect.Effect<
  AgentCoordinationReadinessResult,
  unknown,
  Firegrid | HostPlaneChannelRouter
> =>
  Effect.gen(function*() {
    const client = yield* runAgentCoordinationReadinessSmokeViaClient(runId)

    // Step 5b — direct router dispatch (independent of client-sdk).
    // Use `(TextChunk.sequence - 1)` as the EXCLUSIVE cursor so the
    // route returns the same TextChunk row both paths observed.
    const router = yield* HostPlaneChannelRouter
    const routed = yield* router.dispatch({
      verb: "wait_for",
      target: SessionAgentOutputChannelTarget,
      payload: {
        sessionId: client.childSessionId,
        afterSequence: client.observedViaClient.sequence - 1,
      },
    })
    const observedViaRouter = routed as RuntimeAgentOutputObservation

    return {
      ...client,
      observedViaRouter,
    }
  })
