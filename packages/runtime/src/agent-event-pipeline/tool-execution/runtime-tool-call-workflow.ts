import { Prompt } from "@effect/ai"
import { Effect } from "effect"
import {
  ToolCallWorkflow,
} from "../../workflow-engine/workflows/tool-call.ts"
import { RuntimeToolUseExecutor } from "../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"
import type { ToolResultEvent } from "../events/index.ts"
import {
  RuntimeToolResultTable,
  runtimeToolResultAtMostOnce,
} from "./runtime-tool-result-table.ts"

export { ToolCallWorkflow } from "../../workflow-engine/workflows/tool-call.ts"

// `ToolCallWorkflow` is retained as a thin facade so host-sdk's toolkit
// handler (`handleTool` in toolkit-layer.ts) can keep its current invocation
// shape during CC4. Its at-most-once semantics are now owned by
// `RuntimeToolResultTable` (Shape C / tf-28b8 #676 verdict — durable result
// identity, NOT workflow-engine memoization). The Workflow surface itself is a
// deletion candidate once host-sdk callers move to the underlying Shape C
// primitive. Tracking bead: tf-jpcg.
export const RuntimeToolCallWorkflowLayer = ToolCallWorkflow.toLayer(
  ({ contextId, toolUseId, toolName, input }) =>
    Effect.gen(function*() {
      const executor = yield* RuntimeToolUseExecutor
      const table = yield* RuntimeToolResultTable
      // The executor's R is `WorkflowEngine | WorkflowInstance` (host-sdk
      // implementation detail, CC4 scope). Inside the ToolCallWorkflow body
      // those are ambient, so the call is well-typed at runtime; the cast
      // crosses the type-system boundary explicitly to keep
      // `runtimeToolResultAtMostOnce`'s contract clean (`R = never`).
      const runEffect = executor.execute(
        { contextId },
        {
          _tag: "ToolUse",
          part: Prompt.toolCallPart({
            id: toolUseId,
            name: toolName,
            params: input,
            providerExecuted: false,
          }),
        },
      ) as unknown as Effect.Effect<ToolResultEvent, unknown, never>
      return yield* runtimeToolResultAtMostOnce(table, {
        contextId,
        toolUseId,
        toolName,
        runEffect,
      }).pipe(Effect.orDie)
    }),
)
