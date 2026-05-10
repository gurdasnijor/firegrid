import {
  readRetainedJson,
  type DurableStreamLogError,
} from "@firegrid/durable-streams/log"
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
  type EventSourceService,
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

export interface RuntimeOutputContextEventSourceOptions
  extends RuntimeOutputEventSourceOptions {
  readonly contextId: string
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

const mapDurableStreamLogError = (
  cause: DurableStreamLogError,
): RuntimeOutputSourceError =>
  new RuntimeOutputSourceError({ op: `readRuntimeJournal.${cause.op}`, cause })

const runtimeJournalEventSourceLive = (
  read: Effect.Effect<{
    readonly events: ReadonlyArray<unknown>
    readonly failures: ReadonlyArray<EventPipelineFailure>
  }, EventSourceError>,
) =>
  Layer.succeed(
    EventSource,
    EventSource.of({ read }),
  )

/**
 * firegrid-event-pipeline-materialization.SOURCE.1
 * firegrid-event-pipeline-materialization.SOURCE.2
 */
export const readRuntimeJournal = Effect.fn("readRuntimeJournal")(
  function* (options: {
    readonly streamUrl: string
    readonly contextId?: string
  }) {
    const rows = yield* readRetainedJson<unknown>({
      streamUrl: options.streamUrl,
    }).pipe(Effect.mapError(mapDurableStreamLogError))

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

export const RawRuntimeJournalEventSourceLive = (
  options: RuntimeOutputEventSourceOptions,
) =>
  runtimeJournalEventSourceLive(rawRuntimeJournalEventSource(options).read)

export const rawRuntimeJournalEventSource = (
  options: RuntimeOutputEventSourceOptions,
): EventSourceService<RuntimeJournalEvent> =>
  ({
    read: readRuntimeJournal(options).pipe(
      Effect.mapError(mapSourceError),
      Effect.map(journal => ({
        events: journal.events,
        failures: journal.decodeFailures,
      })),
    ),
  })

export const runtimeOutputEventSource = (
  options: RuntimeOutputContextEventSourceOptions,
): EventSourceService<RuntimeEvent> =>
  ({
    read: readRuntimeJournal(options).pipe(
      Effect.mapError(mapSourceError),
      Effect.map(journal => ({
        events: stdoutRowsForContext(journal.events, options),
        failures: journal.decodeFailures,
      })),
    ),
  })

export const RuntimeOutputEventSourceLive = (
  options: RuntimeOutputContextEventSourceOptions,
) =>
  runtimeJournalEventSourceLive(
    runtimeOutputEventSource(options).read,
  )
