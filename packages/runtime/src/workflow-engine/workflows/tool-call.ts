import { Workflow } from "@effect/workflow"
import { Schema } from "effect"
import { ToolResultEventSchema } from "../../events/index.ts"

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
