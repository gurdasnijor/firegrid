import { WorkflowEngine } from "@effect/workflow"
import { Context, Effect, Layer, Scope } from "effect"
import { fireDueWorkflowClocks } from "./durable-workflow/clock.js"
import { makeWorkflowEngine } from "./durable-workflow/engine-runtime.js"
import {
  acquireWorkflowStateStore,
  WorkflowStateStore,
  type WorkflowEngineDurableStateOptions,
  type WorkflowStateStoreError,
} from "./durable-workflow/state.js"

export * from "./durable-workflow/clock.js"
export * from "./durable-workflow/state.js"

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

export const layer = (
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

export const layerDurableStreams = layer

export { fireDueWorkflowClocks }
