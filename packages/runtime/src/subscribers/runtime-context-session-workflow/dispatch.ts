// Typed dispatch surface for callers of the
// `RuntimeContextSessionWorkflow`. Two callers in production:
//
//   1. `subscribers/runtime-control/control-request-side-effects.start` —
//      calls `dispatch` to admit the workflow ONCE per (contextId, attempt).
//      No direct `RuntimeContextWorkflowSession.startOrAttach` call from
//      the control plane anymore; the workflow is the sole admission boundary.
//
//   2. `subscribers/runtime-context/index.ts:handle` Input branch — calls
//      `resume` as a wakeup when a new input intent arrives. No direct
//      `session.send` call from the Shape C subscriber anymore; the
//      workflow body owns input dispatch.
//
// The wrapper Tag exists so callers don't have to re-derive the executionId
// from payload at every call site (a stable helper + one place to add
// observability later).

import { WorkflowEngine } from "@effect/workflow"
import { Context, Effect, Layer } from "effect"
import {
  RuntimeContextSessionWorkflow,
  type RuntimeContextSessionWorkflowSuccess,
} from "./workflow.ts"

export interface RuntimeContextSessionWorkflowDispatchService {
  /**
   * Admit the workflow for `(contextId, activityAttempt)`. Idempotent —
   * concurrent calls collapse via the workflow's idempotencyKey. Returns
   * when the workflow body completes (terminal status surfaced as
   * success / failed). Callers usually wrap with their own
   * `runs.waitTerminal` if they want to await the runs.exited row chain
   * independently.
   */
  readonly dispatch: (input: {
    readonly contextId: string
    readonly activityAttempt: number
  }) => Effect.Effect<RuntimeContextSessionWorkflowSuccess, unknown>

  /**
   * Best-effort wakeup. Used by the Shape C subscriber on Input events.
   * If the workflow execution doesn't exist yet (early input race), this
   * is a no-op — the workflow body will pick the intent up via its
   * unprocessed-intent query when it eventually starts.
   */
  readonly resume: (input: {
    readonly contextId: string
    readonly activityAttempt: number
  }) => Effect.Effect<void, never>
}

export class RuntimeContextSessionWorkflowDispatch extends Context.Tag(
  "firegrid/runtime/RuntimeContextSessionWorkflowDispatch",
)<
  RuntimeContextSessionWorkflowDispatch,
  RuntimeContextSessionWorkflowDispatchService
>() {}

export const RuntimeContextSessionWorkflowDispatchLive = Layer.effect(
  RuntimeContextSessionWorkflowDispatch,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    return RuntimeContextSessionWorkflowDispatch.of({
      dispatch: (input) =>
        RuntimeContextSessionWorkflow.execute(input).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        ),
      resume: (input) =>
        Effect.gen(function*() {
          const executionId = yield* RuntimeContextSessionWorkflow.executionId(input)
          yield* RuntimeContextSessionWorkflow.resume(executionId).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            // Best-effort: missing execution + already-running both no-op.
            Effect.ignore,
          )
        }),
    })
  }),
)
