// Shape C Wave C — non-recursive public start facade (client/public side).
//
// Maps to production `startRuntime(...)` in
// `packages/host-sdk/src/host/commands.ts:188`. The non-recursive contract:
//
//   1. Call `host.sessions.start` (CallableChannel) — returns
//      `RuntimeStartRequestAck` (durable row inserted).
//   2. Observe `session.agent_output` via `wait_for` filtered by tag —
//      terminal observation is `Terminated` (with `exitCode`) OR `Error`.
//   3. Return the observation to the caller. Do NOT write another
//      start-request, do NOT call any internal substrate function, do NOT
//      reach into the reconciler or the internal side-effect.
//
// The public facade only knows the router. Everything below the router is
// runtime-internal substrate (`runtime.ts`). This file's import list is
// the structural recursion guard — it imports the `Router` interface (the
// typed dispatch surface) plus the observation/ack types for typing the
// return value. It does NOT import the substrate factory, the reconciler,
// or the internal start side-effect. The test asserts this via file-text
// grep on call-sites of those runtime-internal symbols.

import { Effect } from "effect"
import type {
  Router,
  RuntimeStartRequestAck,
  SessionAgentOutputObservation,
} from "./runtime.ts"

export interface StartSessionRequest {
  readonly sessionId: string
}

export interface StartSessionOutcome {
  readonly ack: RuntimeStartRequestAck
  readonly terminal: SessionAgentOutputObservation
}

/**
 * Public start facade. Production analogue: `startRuntime(...)` in
 * `packages/host-sdk/src/host/commands.ts:188`.
 *
 * Flow:
 *   call host.sessions.start  →  durable startRequests row written
 *   wait_for session.agent_output (filter on terminal _tag)
 *                             →  observation returned
 *
 * The facade has ONE writing dispatch (`host.sessions.start`) and ONE
 * observation loop (`session.agent_output`). No second start-request is
 * ever written by the facade itself; the recursion bug CC1 hit is
 * structurally impossible from this code path because the facade does
 * not invoke any callback that could re-enter `host.sessions.start`.
 */
export const startSession = (
  router: Router,
  request: StartSessionRequest,
): Effect.Effect<StartSessionOutcome, Error> =>
  Effect.gen(function*() {
    const ack = yield* router.dispatch.call("host.sessions.start", {
      sessionId: request.sessionId,
    })
    // Observation loop: wait_for the next observation after the cursor and
    // return when a terminal tag arrives. Mirrors the
    // `forAgentOutput` + tag-filter pattern production uses (cf.
    // `firegrid.ts:743` `waitForPermissionRequest`).
    let cursor = -1
    // Bounded loop: in this sim the internal side-effect emits at most 2
    // observations (Error + Terminated, or just Terminated). A real
    // facade would loop until terminal; we cap the loop to make the
    // recursion-counter assertions exact.
    for (let step = 0; step < 8; step += 1) {
      const observation = yield* router.dispatch.waitFor("session.agent_output", {
        sessionId: request.sessionId,
        afterSequence: cursor,
      })
      cursor = observation.sequence
      if (observation._tag === "Terminated" || observation._tag === "Error") {
        return { ack, terminal: observation }
      }
    }
    return yield* Effect.fail(
      new Error("startSession: terminal observation not received within bound"),
    )
  })
