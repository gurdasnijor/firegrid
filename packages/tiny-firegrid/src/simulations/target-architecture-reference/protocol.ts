import {
  makeChannelTarget,
} from "@firegrid/protocol/channels"
import type { ChannelDispatchRequest } from "@firegrid/protocol/channels/router"
import { Schema } from "effect"

export const targetArchitectureReferenceInputChannelTarget = makeChannelTarget(
  "tiny.reference.phase0b.session_input",
)

export const targetArchitectureReferenceOutputChannelTarget = makeChannelTarget(
  "tiny.reference.phase0b.agent_output",
)

export const WorkflowInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.String.pipe(Schema.minLength(1)),
  sequence: Schema.Number,
  kind: Schema.Literal("prompt", "tool_result"),
  body: Schema.String,
  toolCallId: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.workflowInput",
  title: "Tiny reference workflow-owned input",
})
type WorkflowInput = Schema.Schema.Type<typeof WorkflowInputSchema>

export const WorkflowOutputWaitSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  observerId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.outputWait",
  title: "Tiny reference output wait cursor",
})
type WorkflowOutputWait = Schema.Schema.Type<typeof WorkflowOutputWaitSchema>

const WorkflowOutputSchema = Schema.Struct({
  outputKey: Schema.String,
  sessionId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("TextChunk", "ToolUse", "ToolResult", "TurnComplete"),
  body: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.output",
  title: "Tiny reference workflow-owned output",
})

export const WorkflowOutputObservationSchema = Schema.Struct({
  observerId: Schema.String,
  nextSequence: Schema.Number,
  observationAttempts: Schema.Number,
  output: WorkflowOutputSchema,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.outputObservation",
  title: "Tiny reference durable output observation",
})
export type WorkflowOutputObservation = Schema.Schema.Type<
  typeof WorkflowOutputObservationSchema
>

export const sendWorkflowInput = (
  payload: WorkflowInput,
): ChannelDispatchRequest => ({
  target: targetArchitectureReferenceInputChannelTarget,
  verb: "send",
  payload,
})

export const waitForWorkflowOutput = (
  payload: WorkflowOutputWait,
): ChannelDispatchRequest => ({
  target: targetArchitectureReferenceOutputChannelTarget,
  verb: "wait_for",
  payload,
})
