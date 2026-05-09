import { WorkflowEngine } from "@effect/workflow"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import { fireDueWorkflowClocks } from "./clock.ts"
import { makeWorkflowEngine } from "./engine-runtime.ts"
import {
  acquireWorkflowStateStore,
  WorkflowStateStore,
  type WorkflowEngineDurableStateOptions,
  type WorkflowStateStoreError,
} from "./state.ts"

export * from "./clock.ts"
export * from "./state.ts"

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

export { fireDueWorkflowClocks }
