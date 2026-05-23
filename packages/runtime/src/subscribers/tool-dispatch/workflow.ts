// Shape D — Activity memoization.
//
// `ToolCallWorkflow` is the workflow-identity-keyed at-most-once tool-call
// dispatch surface; `RuntimeToolCallWorkflowLayer` registers the handler that
// runs each call through the runtime-owned `RuntimeToolUseExecutor` capability.
//
// Source physically moved from
// `packages/runtime/src/workflow-engine/workflows/tool-call.ts` and
// `packages/runtime/src/subscribers/tool-dispatch/runtime-tool-call-workflow.ts`
// per `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
// §subscribers/tool-dispatch/ + the post-#727 tf-up1v amendment. The
// load-bearing `@effect/workflow` machinery (`Workflow.make`,
// `Workflow.toLayer`) stays inside this folder, justified by the Shape D
// rationale in `./README.md`.

import { Prompt } from "@effect/ai"
import { Workflow } from "@effect/workflow"
import { Effect, Schema } from "effect"
import { ToolResultEventSchema } from "../../events/index.ts"
import { RuntimeToolUseExecutor } from "./runtime-tool-use-executor.ts"

export const ToolCallWorkflowPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
})

export type ToolCallWorkflowPayload = Schema.Schema.Type<
  typeof ToolCallWorkflowPayloadSchema
>

export const ToolCallWorkflow = Workflow.make({
  name: "firegrid.agent-tool-call",
  payload: ToolCallWorkflowPayloadSchema,
  success: ToolResultEventSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

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
