import type {
  FiregridHost,
} from "@firegrid/host-sdk"
import {
  ChannelRouteVerbNotSupported,
  type ChannelDispatchRequest,
} from "@firegrid/protocol/channels/router"
import {
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  targetArchitectureReferenceChannelTarget,
  WorkflowTableCursorSnapshotSchema,
  WorkflowTableCursorWaitSchema,
  WorkflowTableMessageSchema,
  type WorkflowTableCursorSnapshot,
} from "./protocol.ts"
import {
  TargetArchitectureReferenceTable,
  targetArchitectureReferenceTableOptions,
  workflowCursorId,
  type WorkflowCursorRow,
  type WorkflowOwnedMessageRow,
} from "./resources.ts"

interface TargetArchitectureReferenceRuntime {
  readonly dispatch: (
    request: ChannelDispatchRequest,
  ) => Effect.Effect<unknown, unknown>
  readonly durableRows: Effect.Effect<{
    readonly messages: ReadonlyArray<WorkflowOwnedMessageRow>
    readonly cursors: ReadonlyArray<WorkflowCursorRow>
  }, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: TargetArchitectureReferenceRuntime) => void =
    () => undefined
  const promise = new Promise<TargetArchitectureReferenceRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return {
    promise,
    resolve: resolveRuntime,
  }
})()

export const targetArchitectureReferenceRuntime = runtimeLatch.promise

const now = (): string => new Date().toISOString()

const initialCursor = (): WorkflowCursorRow => ({
  cursorId: workflowCursorId,
  lastSequence: 0,
  processedCount: 0,
  processedMessageIds: [],
  updatedAt: now(),
})

const snapshotFromCursor = (
  cursor: WorkflowCursorRow,
): WorkflowTableCursorSnapshot => ({
  cursorId: cursor.cursorId,
  lastSequence: cursor.lastSequence,
  processedCount: cursor.processedCount,
  processedMessageIds: cursor.processedMessageIds,
})

const readCursor = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  table.cursors.get(workflowCursorId).pipe(
    Effect.map(Option.getOrElse(initialCursor)),
  )

const advanceCursor = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  Effect.gen(function*() {
    const cursor = yield* readCursor(table)
    const rows = yield* table.messages.query((coll) =>
      coll.toArray
        .filter(row => row.sequence > cursor.lastSequence)
        .sort((left, right) => left.sequence - right.sequence),
    )
    if (rows.length === 0) return cursor

    const processedAt = now()
    const last = rows[rows.length - 1]
    if (last === undefined) return cursor
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.cursor.from_sequence": cursor.lastSequence,
      "firegrid.tiny_reference.cursor.to_sequence": last.sequence,
      "firegrid.tiny_reference.cursor.advance_count": rows.length,
      "firegrid.tiny_reference.message_ids": rows
        .map(row => row.messageId)
        .join(","),
    })
    yield* Effect.forEach(
      rows,
      row => table.messages.upsert({ ...row, processedAt }),
      { discard: true },
    )
    const next: WorkflowCursorRow = {
      cursorId: workflowCursorId,
      lastSequence: last.sequence,
      processedCount: cursor.processedCount + rows.length,
      processedMessageIds: [
        ...cursor.processedMessageIds,
        ...rows.map(row => row.messageId),
      ],
      updatedAt: processedAt,
    }
    yield* table.cursors.upsert(next)
    return next
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.workflow.cursor_advance", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TargetArchitectureReferencePhase0AWorkflow",
      },
    }),
  )

const runWorkflow = (
  table: TargetArchitectureReferenceTable["Type"],
) =>
  table.messages.rows().pipe(
    Stream.runForEach(row =>
      Effect.gen(function*() {
        yield* Effect.succeed(row).pipe(
          Effect.withSpan("firegrid.tiny_reference.workflow.read_table", {
            kind: "consumer",
            attributes: {
              "firegrid.channel.target": String(
                targetArchitectureReferenceChannelTarget,
              ),
              "firegrid.tiny_reference.message_id": row.messageId,
              "firegrid.tiny_reference.sequence": row.sequence,
            },
          }),
        )
        yield* advanceCursor(table)
      }),
    ),
  )

const writeMessage = (
  table: TargetArchitectureReferenceTable["Type"],
  payload: unknown,
) =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknown(WorkflowTableMessageSchema, {
      onExcessProperty: "error",
    })(payload)
    const row: WorkflowOwnedMessageRow = {
      ...decoded,
      acceptedAt: now(),
    }
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.message_id": row.messageId,
      "firegrid.tiny_reference.sequence": row.sequence,
    })
    yield* table.messages.upsert(row)
    return row
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.channel.write", {
      kind: "producer",
      attributes: {
        "firegrid.channel.target": String(targetArchitectureReferenceChannelTarget),
        "firegrid.channel.verb": "send",
      },
    }),
  )

const waitForCursor = (
  table: TargetArchitectureReferenceTable["Type"],
  payload: unknown,
) =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknown(WorkflowTableCursorWaitSchema, {
      onExcessProperty: "error",
    })(payload)
    const row = yield* table.cursors.rows().pipe(
      Stream.filter(row => row.lastSequence >= decoded.minSequence),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () => Effect.never,
        onSome: row => Effect.succeed(row),
      })),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_reference.cursor.min_sequence": decoded.minSequence,
      "firegrid.tiny_reference.cursor.last_sequence": row.lastSequence,
      "firegrid.tiny_reference.cursor.processed_count": row.processedCount,
      "firegrid.tiny_reference.cursor.processed_message_ids": row
        .processedMessageIds
        .join(","),
    })
    return yield* Schema.decodeUnknown(WorkflowTableCursorSnapshotSchema)(
      snapshotFromCursor(row),
    )
  }).pipe(
    Effect.withSpan("firegrid.tiny_reference.channel.read", {
      kind: "consumer",
      attributes: {
        "firegrid.channel.target": String(targetArchitectureReferenceChannelTarget),
        "firegrid.channel.verb": "wait_for",
      },
    }),
  )

const dispatchFor = (
  table: TargetArchitectureReferenceTable["Type"],
): TargetArchitectureReferenceRuntime["dispatch"] =>
  (request) =>
    Effect.gen(function*() {
      if (String(request.target) !== String(targetArchitectureReferenceChannelTarget)) {
        return yield* Effect.fail({
          _tag: "UnknownChannelTarget",
          target: String(request.target),
        })
      }
      switch (request.verb) {
        case "send":
          return yield* writeMessage(table, request.payload)
        case "wait_for":
          return yield* waitForCursor(table, request.payload)
        case "call":
          return yield* Effect.fail(new ChannelRouteVerbNotSupported({
            target: String(targetArchitectureReferenceChannelTarget),
            verb: "call",
            direction: "bidirectional",
            supportedVerbs: ["send", "wait_for"],
          }))
      }
    }).pipe(
      Effect.withSpan("firegrid.channel.dispatch", {
        kind: "internal",
        attributes: {
          "firegrid.channel.target": String(request.target),
          "firegrid.channel.verb": request.verb,
          "firegrid.channel.direction": "bidirectional",
        },
      }),
    )

const runtimeFor = (
  table: TargetArchitectureReferenceTable["Type"],
): TargetArchitectureReferenceRuntime => ({
  dispatch: dispatchFor(table),
  durableRows: Effect.gen(function*() {
    const messages = yield* table.messages.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const cursors = yield* table.cursors.query(coll =>
      coll.toArray.sort((left, right) =>
        left.cursorId.localeCompare(right.cursorId),
      ),
    )
    return { messages, cursors }
  }),
})

export const targetArchitectureReferenceHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = TargetArchitectureReferenceTable.layer(
    targetArchitectureReferenceTableOptions(env),
  )
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* TargetArchitectureReferenceTable
      const runtime = runtimeFor(table)
      runtimeLatch.resolve(runtime)
      yield* runWorkflow(table).pipe(Effect.forkScoped)
    }),
  )

  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
