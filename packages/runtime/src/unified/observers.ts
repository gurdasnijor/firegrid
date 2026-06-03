/**
 * JournalObserverLive — output → sibling-workflow trigger.
 *
 * The single piece of glue between the journal and the sibling workflows
 * per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §B. Watches
 * `RuntimeAgentOutputEvents` (the typed projection of
 * `RuntimeOutputTable.events`) and triggers:
 *
 *   - `PermissionRoundtripWorkflow.execute(...)` on each
 *     `PermissionRequest` observation.
 *   - `ToolDispatchWorkflow.execute(...)` on host-dispatched `ToolUse`
 *     observations.
 *
 * Workflow-level idempotency (`Workflow.idempotencyKey`) deduplicates
 * across restarts and replay — same `(contextId, permissionRequestId)`
 * or same `toolUseId` collapses to one execution, no matter how many
 * times the observer fires. The observer is therefore allowed to be
 * naïve about "have I seen this before".
 *
 * Forked as a daemon at Layer scope; one observer per host. Both
 * sibling workflows perform their own feedback `sendSignal` back to
 * the originating session workflow (§D, §E), so the observer's job
 * ends at "execute the workflow".
 *
 * Implementation note: the observer captures the FULL service context
 * at Layer-build time via `Effect.context()` and provides it back when
 * forking workflow.execute(). The workflow's body Layer is registered
 * with the engine, but the engine resolves the body's R-channel from
 * the surrounding scope at execute-time — without re-providing the
 * captured context, `SignalTable` / `UnifiedTable` / `WorkflowEngine`
 * are not reachable from the forked effect's own scope.
 */

import { type WorkflowEngine } from "@effect/workflow"
import { type Context, Effect, Layer, Stream } from "effect"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
} from "../tables/runtime-output.ts"
import {
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
} from "./subscribers/permission-and-tool.ts"
import { RuntimeContextSessionWorkflow } from "./subscribers/runtime-context.ts"
import { type UnifiedTable } from "./tables.ts"
import { type RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"

type CapturedServices =
  | WorkflowEngine.WorkflowEngine
  | UnifiedTable

const triggerForObservation = (
  captured: Context.Context<CapturedServices>,
) =>
(observation: RuntimeAgentOutputObservation) => {
  switch (observation._tag) {
    case "PermissionRequest":
      return Effect.fork(
        PermissionRoundtripWorkflow.execute({
          contextId: observation.contextId,
          attempt: observation.activityAttempt,
          permissionRequestId: observation.event.permissionRequestId,
          toolUseId: observation.event.toolUseId,
        }).pipe(
          Effect.provide(captured),
          Effect.orDie,
        ),
      )

    case "ToolUse":
      // firegrid-runtime-host-modularity.CODEC_RUNTIME.4
      // firegrid-runtime-host-modularity.CODEC_RUNTIME.5
      if (observation.event.part.providerExecuted === true) return Effect.void
      return Effect.fork(
        ToolDispatchWorkflow.execute({
          contextId: observation.contextId,
          attempt: observation.activityAttempt,
          toolUseId: observation.event.part.id,
          toolName: observation.event.part.name,
          inputJson: JSON.stringify(observation.event.part.params),
        }).pipe(
          Effect.provide(captured),
          Effect.orDie,
        ),
      )

    case "Terminated":
      // tf-r06u.36 — NATURAL process exit. The codec emits `Terminated` after
      // the agent process exits; without this case it hit `default` and nothing
      // ran `deregister`, so the per-context process registry entry + scope
      // leaked. Deliver a terminal input to the per-event RuntimeContext handler
      // — the SAME path explicit cancel/close use post-#863 — so the handler
      // runs `adapter.deregister` (Scope.close → byte pipe + output-drain + the
      // already-exited process reaped) and returns. Idempotent: the workflow
      // `idempotencyKey` is `session.terminated:${contextId}` and `deregister`
      // no-ops once the registry entry is gone, so a cancel-then-natural-exit
      // (or a re-observed `Terminated`) reaps at most once.
      //
      // ONLY `Terminated` (+ the already-wired explicit cancel/close) is
      // terminal. `TurnComplete` is deliberately NOT here: it fires every turn,
      // so deregistering on it would kill multi-turn sessions after turn 1
      // (confirmed by 3 prior reviews — honor it).
      return Effect.fork(
        RuntimeContextSessionWorkflow.execute({
          contextId: observation.contextId,
          attempt: observation.activityAttempt,
          inputKey: `session.terminated:${observation.contextId}`,
          input: {
            kind: "terminal",
            payloadJson: JSON.stringify({ operation: "terminated" }),
          },
        }, { discard: true }).pipe(
          Effect.provide(captured),
          Effect.orDie,
        ),
      )

    default:
      return Effect.void
  }
}

/**
 * Daemon Layer. Acquires the observation stream at scope, captures the
 * service context needed to satisfy sibling-workflow bodies' R-channels,
 * forks a daemon fiber consuming the stream indefinitely. Layer scope
 * ends → daemon fiber is interrupted; no manual teardown required.
 */
export const JournalObserverLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const captured = yield* Effect.context<CapturedServices>()
    const observations = yield* RuntimeAgentOutputEvents
    const trigger = triggerForObservation(captured)
    yield* observations.pipe(
      Stream.tap(trigger),
      Stream.runDrain,
      Effect.withSpan("firegrid.unified.journal_observer.daemon", {
        kind: "consumer",
        attributes: {
          "firegrid.unified.observer.kind": "journal-to-sibling-workflows",
        },
      }),
      Effect.forkScoped,
    )
  }),
).pipe(Layer.provide(RuntimeAgentOutputEventsLayer))
