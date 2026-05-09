import { stream as readStream } from "@durable-streams/client"
import {
  compareRuntimeOutputOrder,
  isAfterRuntimeOutputCursor,
  RuntimeJournalEventSchema,
  type RuntimeEvent,
  type RuntimeJournalEvent,
  type RuntimeOutputCursor,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Schema } from "effect"
import {
  EventSource,
  EventSourceError,
  type EventPipelineFailure,
} from "./event-pipeline.ts"

export class RuntimeOutputSourceError extends Schema.TaggedError<RuntimeOutputSourceError>()(
  "RuntimeOutputSourceError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type RuntimeJournalReadResult = {
  readonly events: ReadonlyArray<RuntimeJournalEvent>
  readonly decodeFailures: ReadonlyArray<EventPipelineFailure>
}

export interface RuntimeOutputEventSourceOptions {
  readonly streamUrl: string
  readonly contextId?: string
  readonly since?: RuntimeOutputCursor
}

const decodeJournalEvent = Schema.decodeUnknownEither(RuntimeJournalEventSchema)

const peekContextId = (
  row: unknown,
): string | undefined => {
  if (typeof row !== "object" || row === null) return undefined
  const envelope = row as Record<string, unknown>
  const payload = envelope.event ?? envelope.log
  if (typeof payload !== "object" || payload === null) return undefined
  const contextId = (payload as Record<string, unknown>).contextId
  return typeof contextId === "string" ? contextId : undefined
}

const peekRuntimeEventId = (
  row: unknown,
): string =>
  typeof row === "object" &&
    row !== null &&
    "id" in row &&
    typeof row.id === "string"
    ? row.id
    : "<undecoded>"

const mapSourceError = (
  cause: RuntimeOutputSourceError,
): EventSourceError =>
  new EventSourceError({ op: cause.op, cause })

/**
 * firegrid-event-pipeline-materialization.SOURCE.1
 * firegrid-event-pipeline-materialization.SOURCE.2
 */
export const readRuntimeJournal = Effect.fn("readRuntimeJournal")(
  function* (options: {
    readonly streamUrl: string
    readonly contextId?: string
  }) {
    const response = yield* Effect.tryPromise({
      try: () =>
        readStream<unknown>({
          url: options.streamUrl,
          offset: "-1",
          live: false,
          json: true,
        }),
      catch: cause => new RuntimeOutputSourceError({ op: "readRuntimeJournal.fetch", cause }),
    })
    const rows = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: cause => new RuntimeOutputSourceError({ op: "readRuntimeJournal.parse", cause }),
    })

    const candidates = options.contextId === undefined
      ? rows
      : rows.filter(row => peekContextId(row) === options.contextId)
    const decoded = candidates.map(row => ({
      row,
      event: decodeJournalEvent(row),
    }))

    return {
      events: decoded.flatMap(({ event }) =>
        Either.isRight(event) ? [event.right] : []),
      decodeFailures: decoded.flatMap(({ event, row }) =>
        Either.isLeft(event)
          ? [{
            sourceEventId: peekRuntimeEventId(row),
            reason: "decode-failure",
            cause: event.left,
          }]
          : []),
    }
  },
)

export const stdoutRowsForContext = (
  journal: ReadonlyArray<RuntimeJournalEvent>,
  options: {
    readonly contextId: string
    readonly since?: RuntimeOutputCursor
  },
): ReadonlyArray<RuntimeEvent> =>
  journal
    .flatMap(event =>
      event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
    .filter(row => row.contextId === options.contextId)
    .filter(row => isAfterRuntimeOutputCursor(row, options.since))
    .sort(compareRuntimeOutputOrder)

export const RuntimeJournalEventSourceLive = (
  options: RuntimeOutputEventSourceOptions,
) =>
  Layer.succeed(
    EventSource,
    EventSource.of({
      read: readRuntimeJournal(options).pipe(
        Effect.mapError(mapSourceError),
        Effect.map(journal => ({
            events: journal.events,
            failures: journal.decodeFailures,
          })),
      ),
    }),
  )

export const RuntimeOutputEventSourceLive = (
  options: RuntimeOutputEventSourceOptions & { readonly contextId: string },
) =>
  Layer.succeed(
    EventSource,
    EventSource.of({
      read: readRuntimeJournal(options).pipe(
        Effect.mapError(mapSourceError),
        Effect.map(journal => ({
            events: stdoutRowsForContext(journal.events, options),
            failures: journal.decodeFailures,
          })),
      ),
    }),
  )
