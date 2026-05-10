import { WorkflowEngine } from "@effect/workflow"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import { fireDueWorkflowClocks } from "./internal/workflow/clock.ts"
import { makeWorkflowEngine } from "./internal/workflow/engine-runtime.ts"
import {
  acquireWorkflowStateStore,
  WorkflowStateStore,
  type WorkflowEngineDurableStateOptions,
  type WorkflowStateStoreError,
} from "./internal/workflow/state.ts"

export * from "./internal/workflow/clock.ts"
export * from "./internal/workflow/state.ts"

export const make = (
  options: WorkflowEngineDurableStateOptions,
): Effect.Effect<
  WorkflowEngine.WorkflowEngine["Type"],
  WorkflowStateStoreError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // workflow-engine-durable-state.ENGINE.4
    const store = yield* acquireWorkflowStateStore(options)
    return yield* makeWorkflowEngine(store)
  })

const layer = (
  options: WorkflowEngineDurableStateOptions,
) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      // workflow-engine-durable-state.ENGINE.1
      // workflow-engine-durable-state.ENGINE.4
      const store = yield* acquireWorkflowStateStore(options)
      const engine = yield* makeWorkflowEngine(store)
      return Context.make(WorkflowStateStore, store).pipe(
        Context.add(WorkflowEngine.WorkflowEngine, engine),
      )
    }),
  )

export const layerDurableStreams = (
  options: WorkflowEngineDurableStateOptions,
) => layer(options)

export const DurableStreamsWorkflowEngine = {
  make,
  layer,
}

export { fireDueWorkflowClocks }
