import { Firegrid } from "@firegrid/client-sdk/firegrid"
import {
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import {
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { HostPlaneChannelRouter } from "@firegrid/runtime/channels"
import { Data, Effect } from "effect"
import { readinessFixtureAgentRuntime } from "./fixture-agent.ts"

/**
 * Outer-driver smoke for the agent-coordination readiness checklist.
 *
 * Step layout:
 *
 *   - Step 2: planner session createOrLoad through the public
 *     `firegrid.sessions.createOrLoad` (which lowers to the
 *     `host.sessions.create_or_load` route).
 *   - Step 3 (SURROGATE, YELLOW): the outer driver creates the CHILD
 *     session via `firegrid.sessions.createOrLoad` — same router target
 *     as a planner would invoke via `session_new`, but driven from the
 *     OUTER driver rather than from a planner-emitted `session_new`
 *     agent-tool call. CC6 must land the second smoke that drives
 *     `session_new` through real `RuntimeAgentToolExecutionLive`
 *     composition. Tracked in FINDING.md.
 *   - Step 4: the child's fixture agent emits one TextChunk and exits
 *     (the codec turns process-exit into a `Terminated` observation;
 *     a `Ready` observation precedes the TextChunk per the stdio-jsonl
 *     codec's capability advertisement).
 *   - Step 5a (LOAD-BEARING): the outer driver observes the child's
 *     output through the public client method
 *     `handle.wait.forAgentOutput({ afterSequence, ... })`, advancing
 *     the cursor through observations until the `TextChunk` row is
 *     observed.
 *   - Step 5b (LOAD-BEARING, STRICT): the outer driver re-observes the
 *     same `sequence` directly through
 *     `HostPlaneChannelRouter.dispatch({ verb: "wait_for", target:
 *     "session.agent_output", payload: { sessionId, afterSequence }})`
 *     — the ACP/MCP-edge path independent of any client-sdk code. The
 *     `afterSequence` passed to the router is `(TextChunk.sequence - 1)`
 *     so the router returns the same TextChunk row.
 *   - Step 6: OTel spans (`firegrid.channel.dispatch` for the
 *     router-mediated waitFor) — asserted in the smoke test by reading
 *     the recording tracer.
 */

export class ReadinessSmokeFailure extends Data.TaggedClass(
  "ReadinessSmokeFailure",
)<{
  readonly step: string
  readonly message: string
}> {}

export interface AgentCoordinationReadinessResult {
  readonly plannerSessionId: string
  readonly plannerContextId: string
  readonly childSessionId: string
  readonly childContextId: string
  readonly observedViaClient: RuntimeAgentOutputObservation
  readonly observedViaRouter: RuntimeAgentOutputObservation
  readonly clientObservationsCollected: ReadonlyArray<RuntimeAgentOutputObservation>
}

const externalKey = (runId: string, role: "planner" | "child") => ({
  source: "tiny-firegrid.agent-coordination-readiness",
  id: `${runId}:${role}`,
})

export const runAgentCoordinationReadinessSmoke = (
  runId: string,
): Effect.Effect<
  AgentCoordinationReadinessResult,
  unknown,
  Firegrid | HostPlaneChannelRouter
> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid

    // Step 2 — planner created and started through router targets.
    const planner = yield* firegrid.sessions.createOrLoad({
      externalKey: externalKey(runId, "planner"),
      runtime: readinessFixtureAgentRuntime,
      createdBy: "tiny-firegrid.agent-coordination-readiness",
    })
    yield* planner.prompt({
      payload: "planner go",
      idempotencyKey: `${runId}:planner-initial`,
    })
    yield* planner.start()

    // Step 3 (SURROGATE) — child session via createOrLoad. Same router
    // target the planner would hit through `session_new`, driven from
    // the outer driver. YELLOW disclosure in FINDING.md.
    const child = yield* firegrid.sessions.createOrLoad({
      externalKey: externalKey(runId, "child"),
      runtime: readinessFixtureAgentRuntime,
      createdBy: "tiny-firegrid.agent-coordination-readiness",
    })
    yield* child.prompt({
      payload: "child go",
      idempotencyKey: `${runId}:child-initial`,
    })
    yield* child.start()

    // Step 5a — public client method. The fixture agent emits a `Ready`
    // capability advertisement first, then the `TextChunk` we want to
    // observe through both paths. Advance the cursor (round-tripping
    // observed `sequence` back as `afterSequence`) until the TextChunk
    // row is found, mirroring the canonical cursor pattern from
    // `child-output-existing-channel-router` (tf-22fo). The
    // per-handle tracked `lastAgentOutputSequence` (firegrid.ts:879)
    // already does this implicitly when `afterSequence` is omitted, so
    // back-to-back `forAgentOutput({timeoutMs})` calls walk forward.
    const collected: Array<RuntimeAgentOutputObservation> = []
    let observedViaClient: RuntimeAgentOutputObservation | undefined
    for (let step = 0; step < 8; step += 1) {
      const result = yield* child.wait.forAgentOutput({
        timeoutMs: 10_000,
      })
      if (!result.matched) {
        return yield* Effect.fail(
          new ReadinessSmokeFailure({
            step: "5a",
            message:
              `child.wait.forAgentOutput timed out at step ${step}; ` +
              `collected ${collected.length} observations: ` +
              `${collected.map(o => o._tag).join(", ")}`,
          }),
        )
      }
      collected.push(result.output)
      if (result.output._tag === "TextChunk") {
        observedViaClient = result.output
        break
      }
      // Terminal classes: stop walking before exhausting the budget.
      if (
        result.output._tag === "Terminated" ||
        result.output._tag === "TurnComplete"
      ) {
        break
      }
    }
    if (observedViaClient === undefined) {
      return yield* Effect.fail(
        new ReadinessSmokeFailure({
          step: "5a",
          message:
            `child output never produced a TextChunk through the client ` +
            `wait surface; observed: ${collected.map(o => o._tag).join(", ")}`,
        }),
      )
    }

    // Step 5b — direct router dispatch (independent of client-sdk).
    // Use `(TextChunk.sequence - 1)` as the EXCLUSIVE cursor so the
    // route returns the same TextChunk row both paths observed.
    const router = yield* HostPlaneChannelRouter
    const routed = yield* router.dispatch({
      verb: "wait_for",
      target: SessionAgentOutputChannelTarget,
      payload: {
        sessionId: child.sessionId,
        afterSequence: observedViaClient.sequence - 1,
      },
    })
    const observedViaRouter = routed as RuntimeAgentOutputObservation

    return {
      plannerSessionId: planner.sessionId,
      plannerContextId: planner.contextId,
      childSessionId: child.sessionId,
      childContextId: child.contextId,
      observedViaClient,
      observedViaRouter,
      clientObservationsCollected: collected,
    }
  })
