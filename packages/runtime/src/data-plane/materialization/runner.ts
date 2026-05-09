import {
  stream as readStream,
} from "@durable-streams/client"
import {
  compareRuntimeOutputOrder,
  isAfterRuntimeOutputCursor,
  RuntimeJournalEventSchema,
  type RuntimeEvent,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Schema } from "effect"
import {
  producerIdFor,
  StateProtocolProducer,
  toSessionStateEvent,
} from "./producer.ts"
import type {
  MaterializerFailure,
  MaterializerSummary,
  MaterializeRuntimeOutputToSessionOptions,
} from "./types.ts"

export class MaterializerRunnerError extends Schema.TaggedError<MaterializerRunnerError>()(
  "MaterializerRunnerError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type RuntimeJournalReadResult = {
  readonly events: ReadonlyArray<RuntimeJournalEvent>
  readonly decodeFailures: ReadonlyArray<MaterializerFailure>
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

/**
 * Tracer 002 retained-replay reader. This still reads the full retained stream
 * client-side; when a context id is provided it filters before schema decode so
 * unrelated contexts do not pay decode cost. Future tracers may replace this
 * with partitioned runtime-output streams, server-side filtering, or
 * checkpointed subscriber reads.
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
      catch: cause => new MaterializerRunnerError({ op: "readRuntimeJournal.fetch", cause }),
    })
    const rows = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: cause => new MaterializerRunnerError({ op: "readRuntimeJournal.parse", cause }),
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
            sourceRuntimeEventId: peekRuntimeEventId(row),
            reason: "decode-failure",
            cause: event.left,
          }]
          : []),
    }
  },
)

const stdoutRowsForContext = (
  journal: ReadonlyArray<RuntimeJournalEvent>,
  options: MaterializeRuntimeOutputToSessionOptions,
): ReadonlyArray<RuntimeEvent> =>
  journal
    .flatMap(event =>
      event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
    .filter(row => row.contextId === options.contextId)
    .filter(row => isAfterRuntimeOutputCursor(row, options.since))
    .sort(compareRuntimeOutputOrder)

export const materializeRuntimeOutputToSession = Effect.fn(
  "materializeRuntimeOutputToSession",
)(function* (options: MaterializeRuntimeOutputToSessionOptions) {
  return yield* Effect.scoped(Effect.gen(function* () {
    const journal = yield* readRuntimeJournal({
      streamUrl: options.sourceDataPlaneStreamUrl,
      contextId: options.contextId,
    })
    const rows = stdoutRowsForContext(journal.events, options)

    const producerFactory = yield* StateProtocolProducer
    const producer = yield* producerFactory.open({
      streamUrl: options.targetSessionStreamUrl,
      producerId: producerIdFor(options.materializer, options.contextId),
    })

    const initialSummary: MaterializerSummary = {
      rowsRead: rows.length + journal.decodeFailures.length,
      rowsProjected: 0,
      rowsIgnored: 0,
      rowsEmpty: 0,
      rowsFailed: journal.decodeFailures.length,
      changesEmitted: 0,
      failures: journal.decodeFailures,
    }

    const summary = yield* Effect.reduce(rows, initialSummary, (acc, row) => {
      const result = options.materializer.project(row)
      if (result.failures.length > 0) {
        return Effect.succeed({
          ...acc,
          rowsFailed: acc.rowsFailed + 1,
          failures: [...acc.failures, ...result.failures],
        })
      }
      if (result.changes.length === 0) {
        return Effect.succeed({
          ...acc,
          rowsIgnored: acc.rowsIgnored + 1,
        })
      }

      return Effect.forEach(result.changes, change =>
        producer.append(toSessionStateEvent(change, options.materializer)),
      { discard: true }).pipe(
        Effect.as({
          ...acc,
          rowsProjected: acc.rowsProjected + 1,
          changesEmitted: acc.changesEmitted + result.changes.length,
        }),
      )
    })

    yield* producer.flush

    return summary
  }))
})
