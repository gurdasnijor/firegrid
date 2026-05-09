import {
  RuntimeJournalEventSchema,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Schema } from "effect"
import {
  EventSink,
  EventSinkError,
} from "./event-pipeline.ts"
import {
  MaterializationEngine,
  type RuntimeOutputProjectionTarget,
} from "./engines/index.ts"

export interface MaterializeEventSinkOptions {
  readonly target: RuntimeOutputProjectionTarget
}

const sinkError = (
  op: string,
  cause: unknown,
): EventSinkError =>
  new EventSinkError({ op, cause })

const decodeRuntimeJournalEvent = Schema.decodeUnknownEither(RuntimeJournalEventSchema)

/**
 * firegrid-event-pipeline-materialization.SINK.3
 */
export const MaterializeEventSinkLive = (
  options: MaterializeEventSinkOptions,
) =>
  Layer.effect(
    EventSink,
    Effect.gen(function* () {
      const engine = yield* MaterializationEngine

      return EventSink.of({
        writeAll: events =>
          Effect.forEach(events, event => {
            const decoded = decodeRuntimeJournalEvent(event)
            if (Either.isLeft(decoded)) {
              return Effect.fail(sinkError("materialize-event-sink.decode", decoded.left))
            }
            return engine.ingestRuntimeJournal(options.target, decoded.right).pipe(
              Effect.mapError(cause => sinkError("materialize-event-sink.ingest", cause)),
            )
          }, { discard: true }),
        flush: Effect.void,
      })
    }),
  )
