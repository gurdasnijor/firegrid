// Runtime side: register the `ToolCallWorkflow` handler with the engine.
//
// Mirrors production `packages/runtime/src/agent-event-pipeline/tool-execution/
// runtime-tool-call-workflow.ts`:
//
//   export const RuntimeToolCallWorkflowLayer = ToolCallWorkflow.toLayer(
//     ({ contextId, toolUseId, toolName, input }) =>
//       Effect.gen(function*() {
//         const executor = yield* RuntimeToolUseExecutor
//         return yield* executor.execute({ contextId }, ...)
//       }),
//   )
//
// And `packages/runtime/src/subscribers/tool-dispatch/index.ts` re-exports
// it as the tree-aligned Shape D Layer (Wave A forward-target shim).
//
// In this sim, "registration" is an Effect that pulls
// `RuntimeToolUseExecutor` from the environment and registers the
// handler with the `WorkflowEngine`. The handler's `R` is `never` by
// the time it lands in the engine because the executor is closed over
// during registration — that's the Shape D pattern: workflow handlers
// run inside the engine's scope, dependencies are wired at composition.

import { Effect } from "effect"
import {
  handleWorkflow,
  RuntimeToolUseExecutor,
  ToolCallWorkflow,
  WorkflowEngine,
} from "./resources.ts"

/**
 * Register the `ToolCallWorkflow` handler with the `WorkflowEngine`.
 * Re-callable: re-running this Effect after `engine.restart` re-applies
 * the handler. That is the "host composition wires it once at runtime
 * boot" pattern. Production does this by `Layer.provide`-merging
 * `RuntimeToolCallWorkflowLayer` into the runtime root
 * (`composition/host-live.ts`).
 */
export const registerRuntimeToolCallWorkflow: Effect.Effect<
  void,
  unknown,
  WorkflowEngine | RuntimeToolUseExecutor
> = Effect.gen(function*() {
  const engine = yield* WorkflowEngine
  const executor = yield* RuntimeToolUseExecutor
  yield* engine.register(handleWorkflow(ToolCallWorkflow, (payload) =>
    executor.execute(payload)))
})
