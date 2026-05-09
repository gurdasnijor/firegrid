import type { RuntimeOutputCursor } from "@firegrid/protocol/launch"
import { Effect, Layer, Schema } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
} from "./event-pipeline.ts"
import { RuntimeOutputSessionProjectorLive } from "./projectors/index.ts"
import { RuntimeOutputEventSourceLive } from "./runtime-output-source.ts"
import {
  StateProtocolEventSinkLive,
  StateProtocolWriterLive,
} from "./sinks/state-protocol/index.ts"

export interface SessionProjectionOptions {
  readonly runtimeOutputStreamUrl: string
  readonly sessionStateStreamUrl: string
  readonly contextId: string
  readonly since?: RuntimeOutputCursor
}

export class SessionProjectionError extends Schema.TaggedError<SessionProjectionError>()(
  "SessionProjectionError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export const SessionProjectionPipelineLive = (
  options: SessionProjectionOptions,
) => {
  const sourceOptions = options.since === undefined
    ? {
      streamUrl: options.runtimeOutputStreamUrl,
      contextId: options.contextId,
    }
    : {
      streamUrl: options.runtimeOutputStreamUrl,
      contextId: options.contextId,
      since: options.since,
    }

  return EventPipelineLive.pipe(
    Layer.provide(RuntimeOutputEventSourceLive(sourceOptions)),
    Layer.provide(RuntimeOutputSessionProjectorLive),
    Layer.provide(StateProtocolEventSinkLive({
      streamUrl: options.sessionStateStreamUrl,
      contextId: options.contextId,
    })),
    Layer.provide(StateProtocolWriterLive),
  )
}

/**
 * firegrid-event-pipeline-materialization.PIPELINE.1
 * firegrid-event-pipeline-materialization.PIPELINE.2
 * firegrid-event-pipeline-materialization.SINK.2
 */
export const runSessionProjection = Effect.fn("runSessionProjection")(
  function* (options: SessionProjectionOptions) {
    const layer = SessionProjectionPipelineLive(options)
    return yield* Effect.scoped(
      EventPipeline.pipe(
        Effect.flatMap(pipeline => pipeline.run),
        Effect.provide(layer),
        Effect.mapError(cause =>
          new SessionProjectionError({ op: "runSessionProjection", cause })),
      ),
    )
  },
)
