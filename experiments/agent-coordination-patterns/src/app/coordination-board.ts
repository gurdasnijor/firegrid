import { makeBidirectionalChannel, type ChannelRegistration } from "@firegrid/protocol/channels"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"

export const boardChannels = [
  "coordination.work",
  "coordination.claims",
  "coordination.findings",
  "coordination.questions",
  "coordination.reviews",
  "coordination.final",
] as const

export type CoordinationBoardChannel = typeof boardChannels[number]

const CoordinationBoardObjectPayloadSchema = Schema.Struct({
  rowId: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  arm: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.Literal(...boardChannels)),
  kind: Schema.optional(Schema.String),
  workId: Schema.optional(Schema.String),
  claimId: Schema.optional(Schema.String),
  claimantSessionId: Schema.optional(Schema.String),
  observedCursor: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
})

const CoordinationBoardPayloadSchema = Schema.Union(
  CoordinationBoardObjectPayloadSchema,
  Schema.String,
)

const CoordinationBoardRowSchema = Schema.Struct({
  rowId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  arm: Schema.String,
  channel: Schema.Literal(...boardChannels),
  kind: Schema.String,
  workId: Schema.optional(Schema.String),
  claimId: Schema.optional(Schema.String),
  claimantSessionId: Schema.optional(Schema.String),
  observedCursor: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  createdAt: Schema.String,
  payload: Schema.optional(Schema.Unknown),
})

export type CoordinationBoardPayload = Schema.Schema.Type<
  typeof CoordinationBoardObjectPayloadSchema
>
type CoordinationBoardPayloadInput = Schema.Schema.Type<
  typeof CoordinationBoardPayloadSchema
>
export type CoordinationBoardRow = Schema.Schema.Type<
  typeof CoordinationBoardRowSchema
>

const CoordinationBoardTables = {
  rows: CoordinationBoardRowSchema,
} as const

type CoordinationBoardTableService = DurableTableService<typeof CoordinationBoardTables>

class CoordinationBoardTable extends DurableTable(
  "agentCoordinationBoard",
  CoordinationBoardTables,
) {}

const boardTableOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.coordination.board`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const boardTableEffect = <A>(
  tableLayer: ReturnType<typeof CoordinationBoardTable.layer>,
  f: (table: CoordinationBoardTableService) => Effect.Effect<A, DurableTableError>,
): Effect.Effect<A, DurableTableError> =>
  Effect.provide(
    Effect.flatMap(CoordinationBoardTable, f),
    tableLayer,
  ) as Effect.Effect<A, DurableTableError>

const boardRows = (
  tableLayer: ReturnType<typeof CoordinationBoardTable.layer>,
  channel: CoordinationBoardChannel,
  liveRows: Stream.Stream<CoordinationBoardRow>,
): Stream.Stream<CoordinationBoardRow, DurableTableError, never> =>
  Stream.merge(
    Stream.unwrap(
      boardTableEffect(
        tableLayer,
        table =>
          Effect.succeed(
            table.rows.rows().pipe(
              Stream.filter(row => row.channel === channel),
            ),
          ),
      ),
    ),
    // agent-coordination-patterns-experiment.BOARD.7
    liveRows.pipe(Stream.filter(row => row.channel === channel)),
  )

const materializeBoardRow = (
  options: {
    readonly runId: string
    readonly arm: string
    readonly channel: CoordinationBoardChannel
  },
  payload: CoordinationBoardPayload,
): CoordinationBoardRow => {
  const now = new Date().toISOString()
  return {
    rowId: payload.rowId ??
      `${options.runId}:${options.arm}:${options.channel}:${crypto.randomUUID()}`,
    // agent-coordination-patterns-experiment.BOARD.6
    runId: options.runId,
    arm: options.arm,
    channel: options.channel,
    kind: payload.kind ?? "message",
    ...(payload.workId === undefined ? {} : { workId: payload.workId }),
    ...(payload.claimId === undefined ? {} : { claimId: payload.claimId }),
    ...(payload.claimantSessionId === undefined
      ? {}
      : { claimantSessionId: payload.claimantSessionId }),
    ...(payload.observedCursor === undefined
      ? {}
      : { observedCursor: payload.observedCursor }),
    ...(payload.status === undefined ? {} : { status: payload.status }),
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.body === undefined ? {} : { body: payload.body }),
    createdAt: payload.createdAt ?? now,
    ...(payload.payload === undefined ? {} : { payload: payload.payload }),
  }
}

const decodeCoordinationBoardPayload = Schema.decodeUnknown(
  CoordinationBoardObjectPayloadSchema,
)

const normalizeCoordinationBoardPayload = (
  payload: CoordinationBoardPayloadInput,
): Effect.Effect<CoordinationBoardPayload, unknown> => {
  if (typeof payload !== "string") return decodeCoordinationBoardPayload(payload)
  return Effect.try({
    try: () => JSON.parse(payload) as unknown,
    catch: error => error,
  }).pipe(
    Effect.flatMap(decodeCoordinationBoardPayload),
  )
}

export interface CoordinationBoardHost {
  readonly registrations: ReadonlyArray<ChannelRegistration>
  readonly append: (
    channel: CoordinationBoardChannel,
    payload: CoordinationBoardPayload,
  ) => Effect.Effect<CoordinationBoardRow, DurableTableError>
  readonly recordedRows: () => ReadonlyArray<CoordinationBoardRow>
}

export const makeCoordinationBoardHost = (options: {
  readonly baseUrl: string
  readonly namespace: string
  readonly runId: string
  readonly arm: string
}): CoordinationBoardHost => {
  const tableLayer = CoordinationBoardTable.layer(
    boardTableOptions({
      baseUrl: options.baseUrl,
      namespace: options.namespace,
    }),
  )
  const recordedRows: Array<CoordinationBoardRow> = []
  const listeners = new Set<(row: CoordinationBoardRow) => void>()
  const liveRows = Stream.async<CoordinationBoardRow>((emit) => {
    const listener = (row: CoordinationBoardRow) => {
      void emit.single(row)
    }
    listeners.add(listener)
    return Effect.sync(() => {
      listeners.delete(listener)
    })
  })
  const append = (
    channel: CoordinationBoardChannel,
    payload: CoordinationBoardPayload,
  ) => {
    const row = materializeBoardRow({ ...options, channel }, payload)
    recordedRows.push(row)
    return boardTableEffect(
      tableLayer,
      table =>
        table.rows.insert(row).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              listeners.forEach(listener => listener(row))
            })
          ),
          Effect.as(row),
        ),
    )
  }
  const registrations = boardChannels.map(channel =>
    makeBidirectionalChannel({
      target: channel,
      schema: CoordinationBoardPayloadSchema,
      sourceClasses: ["static-source", "predicate-eligible"],
      stream: boardRows(tableLayer, channel, liveRows),
      append: payload =>
        // agent-coordination-patterns-experiment.BOARD.5
        normalizeCoordinationBoardPayload(payload).pipe(
          Effect.flatMap(normalized => append(channel, normalized)),
          Effect.asVoid,
        ),
    })
  )

  return {
    registrations,
    append,
    recordedRows: () => [...recordedRows],
  }
}
