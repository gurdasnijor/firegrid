import { Prompt } from "@effect/ai"
import { Effect } from "effect"
import {
  ToolCallWorkflow,
} from "../../workflow-engine/workflows/tool-call.ts"
import { RuntimeToolUseExecutor } from "../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"

export { ToolCallWorkflow } from "../../workflow-engine/workflows/tool-call.ts"

export const RuntimeToolCallWorkflowLayer = ToolCallWorkflow.toLayer(
  ({ contextId, toolUseId, toolName, input }) =>
    Effect.gen(function*() {
      const executor = yield* RuntimeToolUseExecutor
      return yield* executor.execute(
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
      )
    }),
)
