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
 *   - `ToolDispatchWorkflow.execute(...)` on each `ToolUse` observation.
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
 */

import { WorkflowEngine } from "@effect/workflow"
import { Effect, Layer, Stream } from "effect"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
} from "../tables/runtime-output.ts"
import {
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
} from "./subscribers/permission-and-tool.ts"

const triggerForObservation = (
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
(observation: import("@firegrid/protocol/session-facade").RuntimeAgentOutputObservation) => {
  switch (observation._tag) {
    case "PermissionRequest":
      return Effect.fork(
        PermissionRoundtripWorkflow.execute({
          contextId: observation.contextId,
          attempt: observation.activityAttempt,
          permissionRequestId: observation.event.permissionRequestId,
          toolUseId: observation.event.toolUseId,
        }).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.orDie,
        ),
      )

    case "ToolUse":
      return Effect.fork(
        ToolDispatchWorkflow.execute({
          contextId: observation.contextId,
          attempt: observation.activityAttempt,
          toolUseId: observation.event.part.id,
          toolName: observation.event.part.name,
          inputJson: JSON.stringify(observation.event.part.params),
        }).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.orDie,
        ),
      )

    default:
      return Effect.void
  }
}

/**
 * Daemon Layer. Acquires the observation stream at scope, forks a
 * daemon fiber consuming it indefinitely, triggers the appropriate
 * sibling workflow per observation. Layer scope ends → daemon fiber
 * is interrupted; no manual teardown required.
 */
export const JournalObserverLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const observations = yield* RuntimeAgentOutputEvents
    const trigger = triggerForObservation(engine)
    yield* observations.pipe(
      Stream.tap(trigger),
      Stream.runDrain,
      Effect.forkScoped,
      Effect.withSpan("firegrid.unified.journal_observer.daemon", {
        kind: "consumer",
      }),
    )
  }),
).pipe(Layer.provide(RuntimeAgentOutputEventsLayer))
