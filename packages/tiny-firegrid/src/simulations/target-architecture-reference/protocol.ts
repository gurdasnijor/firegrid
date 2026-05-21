import {
  makeChannelTarget,
} from "@firegrid/protocol/channels"
import type { ChannelDispatchRequest } from "@firegrid/protocol/channels/router"
import { Schema } from "effect"

export const targetArchitectureReferenceChannelTarget = makeChannelTarget(
  "tiny.reference.phase0a.workflow_table",
)

export const WorkflowTableMessageSchema = Schema.Struct({
  messageId: Schema.String.pipe(Schema.minLength(1)),
  sequence: Schema.Number,
  body: Schema.String,
}).annotations({
  identifier: "firegrid.tinyReference.phase0a.workflowTable.message",
  title: "Tiny reference workflow-table message",
})
type WorkflowTableMessage = Schema.Schema.Type<
  typeof WorkflowTableMessageSchema
>

export const WorkflowTableCursorWaitSchema = Schema.Struct({
  minSequence: Schema.Number,
}).annotations({
  identifier: "firegrid.tinyReference.phase0a.workflowTable.cursorWait",
  title: "Tiny reference workflow cursor wait",
})
type WorkflowTableCursorWait = Schema.Schema.Type<
  typeof WorkflowTableCursorWaitSchema
>

export const WorkflowTableCursorSnapshotSchema = Schema.Struct({
  cursorId: Schema.String,
  lastSequence: Schema.Number,
  processedCount: Schema.Number,
  processedMessageIds: Schema.Array(Schema.String),
}).annotations({
  identifier: "firegrid.tinyReference.phase0a.workflowTable.cursorSnapshot",
  title: "Tiny reference workflow cursor snapshot",
})
export type WorkflowTableCursorSnapshot = Schema.Schema.Type<
  typeof WorkflowTableCursorSnapshotSchema
>

export const sendWorkflowTableMessage = (
  payload: WorkflowTableMessage,
): ChannelDispatchRequest => ({
  target: targetArchitectureReferenceChannelTarget,
  verb: "send",
  payload,
})

export const waitForWorkflowTableCursor = (
  payload: WorkflowTableCursorWait,
): ChannelDispatchRequest => ({
  target: targetArchitectureReferenceChannelTarget,
  verb: "wait_for",
  payload,
})
