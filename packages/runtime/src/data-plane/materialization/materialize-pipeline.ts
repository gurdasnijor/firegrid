import type { RuntimeOutputCursor } from "@firegrid/protocol/launch"
import { Effect, Layer, Schema } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
} from "./event-pipeline.ts"
import {
  MaterializeEventSinkLive,
} from "./sinks/materialize/index.ts"
import {
  IdentityEventProjectorLive,
} from "./projectors/index.ts"
import { RawRuntimeJournalEventSourceLive } from "./runtime-output-source.ts"
import type { RuntimeOutputProjectionTarget } from "./materialize/index.ts"

export interface MaterializeRuntimeOutputProjectionOptions {
  readonly runtimeOutputStreamUrl: string
  readonly contextId: string
  readonly target: RuntimeOutputProjectionTarget
  readonly since?: RuntimeOutputCursor
}

export class MaterializeRuntimeOutputProjectionError
  extends Schema.TaggedError<MaterializeRuntimeOutputProjectionError>()(
    "MaterializeRuntimeOutputProjectionError",
    {
      op: Schema.String,
      cause: Schema.Unknown,
    },
  )
{}

export const MaterializeRuntimeOutputPipelineLive = (
  options: MaterializeRuntimeOutputProjectionOptions,
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
    Layer.provide(RawRuntimeJournalEventSourceLive(sourceOptions)),
    Layer.provide(IdentityEventProjectorLive({
      name: "runtime-output-materialize",
      version: "1",
    })),
    Layer.provide(MaterializeEventSinkLive({
      target: options.target,
    })),
  )
}

export const runMaterializeRuntimeOutputProjection = Effect.fn(
  "runMaterializeRuntimeOutputProjection",
)(function* (options: MaterializeRuntimeOutputProjectionOptions) {
  const layer = MaterializeRuntimeOutputPipelineLive(options)
  return yield* EventPipeline.pipe(
    Effect.flatMap(pipeline => pipeline.run),
    Effect.provide(layer),
    Effect.mapError(cause =>
      new MaterializeRuntimeOutputProjectionError({
        op: "runMaterializeRuntimeOutputProjection",
        cause,
      })),
  )
})
