// Shape C Wave C — public start facade (client/public side), with two
// terminal-observation variants for the ordering question:
//
//   startSessionViaAgentOutput   — TRADITIONAL / WRONG-SHAPE
//     observes `session.agent_output` `_tag: "Terminated"` as the
//     terminal contract. Cannon C7 anti-pattern. Subject to the ordering
//     gap CC1 hit.
//
//   startSessionViaLifecycle     — TARGET / RIGHT-SHAPE
//     observes `session.lifecycle` (RuntimeRunEvent) with
//     `status === "exited" | "failed"` as the terminal contract. The
//     observation source IS the durable terminal fact; no ordering gap
//     because the channel can only emit after the row is durably
//     present.
//
// The public facade imports ONLY the typed Router (and the observation/ack
// types) from runtime.ts. It does NOT touch substrate or reconciler. Same
// recursion-guard pattern #706 already established.

import { Effect } from "effect"
import type {
  Router,
  RuntimeRunEvent,
  RuntimeStartRequestAck,
  SessionAgentOutputObservation,
} from "./runtime.ts"

export interface StartSessionRequest {
  readonly sessionId: string
}

export interface StartSessionViaAgentOutputOutcome {
  readonly ack: RuntimeStartRequestAck
  readonly observed: SessionAgentOutputObservation
}

export interface StartSessionViaLifecycleOutcome {
  readonly ack: RuntimeStartRequestAck
  readonly observed: RuntimeRunEvent
}

/**
 * WRONG-SHAPE — synthesizes terminal completion from raw agent-output
 * observation. Production analogue would be a `startRuntime` that loops on
 * `handle.wait.forAgentOutput` looking for `_tag: "Terminated"` and
 * returns immediately. Cannon C7 forbids exactly this. Modeled here so
 * the ordering gap can be reproduced as a test assertion.
 */
export const startSessionViaAgentOutput = (
  router: Router,
  request: StartSessionRequest,
): Effect.Effect<StartSessionViaAgentOutputOutcome, Error> =>
  Effect.gen(function*() {
    const ack = yield* router.dispatch.call("host.sessions.start", {
      sessionId: request.sessionId,
    })
    let cursor = -1
    for (let step = 0; step < 16; step += 1) {
      const observation = yield* router.dispatch.waitForAgentOutput({
        sessionId: request.sessionId,
        afterSequence: cursor,
      })
      cursor = observation.sequence
      if (observation._tag === "Terminated") {
        return { ack, observed: observation }
      }
    }
    return yield* Effect.fail(
      new Error("startSessionViaAgentOutput: terminal not received within bound"),
    )
  })

/**
 * RIGHT-SHAPE — terminal contract bound to the durable run-lifecycle
 * fact. Production analogue: `startRuntime` that calls
 * `HostSessionsStartChannel.binding.call(...)` then `wait_for` on
 * `SessionLifecycleChannel.forSession(sessionId).binding.stream` filtered
 * by `status === "exited" | "failed"`. Closes the ordering gap because
 * the channel's stream IS `control.runs.rows()` — observation cannot
 * resolve before the row exists.
 */
export const startSessionViaLifecycle = (
  router: Router,
  request: StartSessionRequest,
): Effect.Effect<StartSessionViaLifecycleOutcome, Error> =>
  Effect.gen(function*() {
    const ack = yield* router.dispatch.call("host.sessions.start", {
      sessionId: request.sessionId,
    })
    const observed = yield* router.dispatch.waitForLifecycle({
      sessionId: request.sessionId,
      afterStatuses: ["exited", "failed"],
    })
    return { ack, observed }
  })
