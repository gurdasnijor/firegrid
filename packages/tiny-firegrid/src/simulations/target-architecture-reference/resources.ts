import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const workflowCursorId = "phase0a-workflow"

const WorkflowOwnedMessageRowSchema = Schema.Struct({
  messageId: Schema.String.pipe(DurableTable.primaryKey),
  sequence: Schema.Number,
  body: Schema.String,
  acceptedAt: Schema.String,
  processedAt: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.tinyReference.phase0a.workflowOwnedMessageRow",
  title: "Tiny reference workflow-owned message row",
})
export type WorkflowOwnedMessageRow = Schema.Schema.Type<
  typeof WorkflowOwnedMessageRowSchema
>

const WorkflowCursorRowSchema = Schema.Struct({
  cursorId: Schema.String.pipe(DurableTable.primaryKey),
  lastSequence: Schema.Number,
  processedCount: Schema.Number,
  processedMessageIds: Schema.Array(Schema.String),
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0a.workflowCursorRow",
  title: "Tiny reference workflow cursor row",
})
export type WorkflowCursorRow = Schema.Schema.Type<typeof WorkflowCursorRowSchema>

export class TargetArchitectureReferenceTable extends DurableTable(
  "tinyReferencePhase0A",
  {
    messages: WorkflowOwnedMessageRowSchema,
    cursors: WorkflowCursorRowSchema,
  },
) {}

export const targetArchitectureReferenceTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.target-architecture-reference.phase0a.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})
