import { Effect, Layer } from "effect"
import {
  EventSink,
  EventSinkError,
} from "../../event-pipeline.ts"
import type { SessionStateChange } from "./session-state-change.ts"
import {
  StateProtocolWriter,
  toSessionStateEvent,
  writerIdFor,
} from "./state-protocol-writer.ts"

export interface StateProtocolEventSinkOptions {
  readonly streamUrl: string
  readonly contextId: string
}

const sinkError = (
  op: string,
  cause: unknown,
): EventSinkError =>
  new EventSinkError({ op, cause })

const decodeSessionStateChange = (
  event: unknown,
): Effect.Effect<SessionStateChange, EventSinkError> => {
  if (typeof event !== "object" || event === null || !("kind" in event)) {
    return Effect.fail(sinkError(
      "state-protocol-sink.decode",
      new Error("projected event is not a SessionStateChange"),
    ))
  }
  const kind = (event as { readonly kind: unknown }).kind
  if (kind !== "upsertSession" && kind !== "upsertMessage") {
    return Effect.fail(sinkError(
      "state-protocol-sink.decode",
      new Error("unsupported SessionStateChange kind"),
    ))
  }
  return Effect.succeed(event as SessionStateChange)
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
      const writer = yield* StateProtocolWriter

      return EventSink.of({
        writeAll: (events, context) =>
          Effect.scoped(Effect.gen(function* () {
            const handle = yield* writer.open({
              streamUrl: options.streamUrl,
              writerId: writerIdFor(context.projector, options.contextId),
            }).pipe(
              Effect.mapError(cause => sinkError("state-protocol-sink.open", cause)),
            )
            const changes = yield* Effect.forEach(events, decodeSessionStateChange)
            yield* Effect.forEach(changes, change =>
              handle.append(toSessionStateEvent(change, context.projector)).pipe(
                Effect.mapError(cause =>
                  sinkError("state-protocol-sink.append", cause)),
              ), { discard: true })
            yield* handle.flush.pipe(
              Effect.mapError(cause =>
                sinkError("state-protocol-sink.flush", cause)),
            )
            return changes.length
          })),
        flush: Effect.void,
      })
    }),
  )

