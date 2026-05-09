import { RuntimeEventSchema } from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Schema } from "effect"
import {
  EventProjector,
  EventProjectorError,
} from "./event-pipeline.ts"
import type {
  MaterializerProjectResult,
  RuntimeOutputMaterializer,
} from "./types.ts"

const decodeRuntimeEvent = Schema.decodeUnknownEither(RuntimeEventSchema)

const eventProjectorError = (
  op: string,
  cause: unknown,
): EventProjectorError =>
  new EventProjectorError({ op, cause })

const projectResultToEvents = (
  result: MaterializerProjectResult,
) => ({
  events: result.changes,
  failures: result.failures.map(failure => ({
    sourceEventId: failure.sourceRuntimeEventId,
    reason: failure.reason,
    cause: failure.cause,
  })),
})

/**
 * firegrid-event-pipeline-materialization.PROJECTOR.1
 * firegrid-event-pipeline-materialization.PROJECTOR.2
 * firegrid-event-pipeline-materialization.PROJECTOR.3
 */
export const RuntimeOutputMaterializerProjectorLive = (
  materializer: RuntimeOutputMaterializer,
) =>
  Layer.succeed(
    EventProjector,
    EventProjector.of({
      name: materializer.name,
        version: materializer.version,
        project: event => {
          const decoded = decodeRuntimeEvent(event)
        if (Either.isLeft(decoded)) {
          return Effect.fail(eventProjectorError(
            "runtime-output-projector.decode",
            decoded.left,
          ))
        }
        return Effect.succeed(projectResultToEvents(
          materializer.project(decoded.right),
        ))
      },
    }),
  )

export const IdentityEventProjectorLive = (
  options: {
    readonly name: string
    readonly version: string
  },
) =>
  Layer.succeed(
    EventProjector,
    EventProjector.of({
      name: options.name,
      version: options.version,
      project: event =>
        Effect.succeed({
          events: [event],
          failures: [],
        }),
    }),
  )
