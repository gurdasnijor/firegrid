import {
  Effect,
  Schema,
} from "effect"
import {
  sendWorkflowTableMessage,
  waitForWorkflowTableCursor,
  WorkflowTableCursorSnapshotSchema,
  type WorkflowTableCursorSnapshot,
} from "./protocol.ts"
import {
  targetArchitectureReferenceRuntime,
} from "./workflow.ts"

interface TargetArchitectureReferenceVerdict {
  readonly verdict: "GREEN"
  readonly cursor: WorkflowTableCursorSnapshot
  readonly durableRows: {
    readonly messageCount: number
    readonly cursorCount: number
  }
}

export const targetArchitectureReferenceDriver:
  Effect.Effect<TargetArchitectureReferenceVerdict, unknown> = Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => targetArchitectureReferenceRuntime)

    yield* runtime.dispatch(sendWorkflowTableMessage({
      messageId: "phase0a-message-1",
      sequence: 1,
      body: "channel write one",
    }))
    yield* runtime.dispatch(sendWorkflowTableMessage({
      messageId: "phase0a-message-2",
      sequence: 2,
      body: "channel write two",
    }))

    const cursorUnknown = yield* runtime.dispatch(
      waitForWorkflowTableCursor({ minSequence: 2 }),
    )
    const cursor = yield* Schema.decodeUnknown(WorkflowTableCursorSnapshotSchema)(
      cursorUnknown,
    )
    const durableRows = yield* runtime.durableRows
    const processed = durableRows.messages.filter(row =>
      row.processedAt !== undefined)

    if (
      cursor.lastSequence !== 2 ||
      cursor.processedCount !== 2 ||
      durableRows.messages.length !== 2 ||
      durableRows.cursors.length !== 1 ||
      processed.length !== 2
    ) {
      return yield* Effect.fail(new Error(
        `workflow-owned table seam failed: ${JSON.stringify({
          cursor,
          durableRows,
          processed: processed.length,
        })}`,
      ))
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.cursor.last_sequence": cursor.lastSequence,
      "firegrid.tiny_reference.cursor.processed_count": cursor.processedCount,
      "firegrid.tiny_reference.cursor.processed_message_ids": cursor
        .processedMessageIds
        .join(","),
      "firegrid.tiny_reference.durable.messages": durableRows.messages.length,
      "firegrid.tiny_reference.durable.cursors": durableRows.cursors.length,
    })
    return {
      verdict: "GREEN",
      cursor,
      durableRows: {
        messageCount: durableRows.messages.length,
        cursorCount: durableRows.cursors.length,
      },
    } satisfies TargetArchitectureReferenceVerdict
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.phase0a.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_reference.verdict": "GREEN",
        "firegrid.tiny_reference.scope": "individual-workflow-table-seam",
      },
    }),
  )
