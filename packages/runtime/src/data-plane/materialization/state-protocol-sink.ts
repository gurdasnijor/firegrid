import { Effect, Layer } from "effect"
import {
  EventSink,
  EventSinkError,
} from "./event-pipeline.ts"
import {
  producerIdFor,
  StateProtocolProducer,
  toSessionStateEvent,
} from "./producer.ts"
import type { MaterializerChange } from "./types.ts"

export interface StateProtocolEventSinkOptions {
  readonly streamUrl: string
  readonly contextId: string
}

const sinkError = (
  op: string,
  cause: unknown,
): EventSinkError =>
  new EventSinkError({ op, cause })

const decodeMaterializerChange = (
  event: unknown,
): Effect.Effect<MaterializerChange, EventSinkError> => {
  if (typeof event !== "object" || event === null || !("kind" in event)) {
    return Effect.fail(sinkError(
      "state-protocol-sink.decode",
      new Error("projected event is not a MaterializerChange"),
    ))
  }
  const kind = (event as { readonly kind: unknown }).kind
  if (kind !== "upsertSession" && kind !== "upsertMessage") {
    return Effect.fail(sinkError(
      "state-protocol-sink.decode",
      new Error("unsupported MaterializerChange kind"),
    ))
  }
  return Effect.succeed(event as MaterializerChange)
}

/**
 * firegrid-event-pipeline-materialization.SINK.2
 */
export const StateProtocolEventSinkLive = (
  options: StateProtocolEventSinkOptions,
) =>
  Layer.effect(
    EventSink,
    Effect.gen(function* () {
      const producerFactory = yield* StateProtocolProducer

      return EventSink.of({
        writeAll: (events, context) =>
          Effect.scoped(Effect.gen(function* () {
            const producer = yield* producerFactory.open({
              streamUrl: options.streamUrl,
              producerId: producerIdFor(context.projector, options.contextId),
            }).pipe(
              Effect.mapError(cause => sinkError("state-protocol-sink.open", cause)),
            )
            yield* Effect.forEach(events, event =>
              decodeMaterializerChange(event).pipe(
                Effect.flatMap(change =>
                  producer.append(toSessionStateEvent(change, context.projector)).pipe(
                    Effect.mapError(cause =>
                      sinkError("state-protocol-sink.append", cause)),
                  )),
              ), { discard: true })
            yield* producer.flush.pipe(
              Effect.mapError(cause =>
                sinkError("state-protocol-sink.flush", cause)),
            )
            return events.length
          })),
        flush: Effect.void,
      })
    }),
  )
