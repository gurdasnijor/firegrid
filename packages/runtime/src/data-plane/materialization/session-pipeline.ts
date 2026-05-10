import type { RuntimeOutputCursor } from "@firegrid/protocol/launch"
import { Effect, Schema } from "effect"
import { createSessionProjectionDefinition } from "./session-projection-definition.ts"
import { makeStateProtocolStrategy } from "./state-protocol/index.ts"

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

/**
 * firegrid-event-pipeline-materialization.PIPELINE.1
 * firegrid-event-pipeline-materialization.PIPELINE.2
 * firegrid-event-pipeline-materialization.SINK.2
 * firegrid-materialization-engines.ENGINE.6
 */
export const runSessionProjection = Effect.fn("runSessionProjection")(
  function* (options: SessionProjectionOptions) {
    const strategy = makeStateProtocolStrategy({
      streamUrl: options.sessionStateStreamUrl,
      contextId: options.contextId,
    })
    return yield* strategy.run(
      createSessionProjectionDefinition(options),
    ).pipe(
      Effect.mapError(cause =>
        new SessionProjectionError({ op: "runSessionProjection", cause })),
    )
  },
)
