import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const workflowCursorId = "phase0b-workflow"
export const verboseTextChunkCount = 32

const SessionRowSchema = Schema.Struct({
  sessionId: Schema.String.pipe(DurableTable.primaryKey),
  status: Schema.Literal("open", "waiting_for_tool", "complete"),
  result: Schema.optional(Schema.String),
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.sessionRow",
  title: "Tiny reference session row",
})
export type SessionRow = Schema.Schema.Type<typeof SessionRowSchema>

const WorkflowInputRowSchema = Schema.Struct({
  inputKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  inputId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("prompt", "tool_result"),
  body: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  acceptedAt: Schema.String,
  processedAt: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.workflowInputRow",
  title: "Tiny reference workflow-owned input row",
})
export type WorkflowInputRow = Schema.Schema.Type<
  typeof WorkflowInputRowSchema
>

const WorkflowOutputRowSchema = Schema.Struct({
  outputKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("TextChunk", "ToolUse", "ToolResult", "TurnComplete"),
  body: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.workflowOutputRow",
  title: "Tiny reference workflow-owned output row",
})
export type WorkflowOutputRow = Schema.Schema.Type<
  typeof WorkflowOutputRowSchema
>

const WorkflowCursorRowSchema = Schema.Struct({
  cursorId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  lastInputSequence: Schema.Number,
  processedInputCount: Schema.Number,
  processedInputKeys: Schema.Array(Schema.String),
  replayCount: Schema.Number,
  outputCount: Schema.Number,
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.workflowCursorRow",
  title: "Tiny reference workflow cursor row",
})
export type WorkflowCursorRow = Schema.Schema.Type<typeof WorkflowCursorRowSchema>

const OutputObserverRowSchema = Schema.Struct({
  observerId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  nextSequence: Schema.Number,
  observationAttempts: Schema.Number,
  observedOutputKeys: Schema.Array(Schema.String),
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0b.outputObserverRow",
  title: "Tiny reference durable output observer row",
})
export type OutputObserverRow = Schema.Schema.Type<
  typeof OutputObserverRowSchema
>

export class TargetArchitectureReferenceTable extends DurableTable(
  "tinyReferencePhase0B",
  {
    sessions: SessionRowSchema,
    inputs: WorkflowInputRowSchema,
    outputs: WorkflowOutputRowSchema,
    workflowCursors: WorkflowCursorRowSchema,
    outputObservers: OutputObserverRowSchema,
  },
) {}

export const targetArchitectureReferenceTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.target-architecture-reference.phase0b.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})
