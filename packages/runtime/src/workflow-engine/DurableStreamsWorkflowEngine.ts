import { WorkflowEngine } from "@effect/workflow"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { fireDueWorkflowClocks } from "./internal/clock.ts"
import { makeWorkflowEngine } from "./internal/engine-runtime.ts"
import {
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  workflowEngineTableLayerOptions,
} from "./internal/table.ts"

export * from "./internal/clock.ts"
export * from "./internal/table.ts"

export const make = (
  options: WorkflowEngineDurableStateOptions,
): Effect.Effect<
  WorkflowEngine.WorkflowEngine["Type"],
  DurableTableError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // workflow-engine-durable-state.ENGINE.4
    // workflow-engine-durable-state.ENGINE.5
    const table = yield* WorkflowEngineTable
    return yield* makeWorkflowEngine(
      table,
      options.streamUrl,
      options.workerId ?? `worker-${crypto.randomUUID()}`,
      options.headers,
    )
  }).pipe(
    Effect.provide(WorkflowEngineTable.layer(workflowEngineTableLayerOptions(options))),
  )

const layer = (
  options: WorkflowEngineDurableStateOptions,
) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      // workflow-engine-durable-state.ENGINE.1
      // workflow-engine-durable-state.ENGINE.4
      // workflow-engine-durable-state.ENGINE.5
      const table = yield* WorkflowEngineTable
      const engine = yield* makeWorkflowEngine(
        table,
        options.streamUrl,
        options.workerId ?? `worker-${crypto.randomUUID()}`,
        options.headers,
      )
      return Context.make(WorkflowEngineTable, table).pipe(
        Context.add(WorkflowEngine.WorkflowEngine, engine),
      )
    }),
  ).pipe(
    Layer.provide(WorkflowEngineTable.layer(workflowEngineTableLayerOptions(options))),
  )

export const DurableStreamsWorkflowEngine = {
  make,
  layer,
}

export { fireDueWorkflowClocks }
