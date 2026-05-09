import { Effect, Layer, Schema } from "effect"
import {
  EventPipeline,
  EventPipelineLive,
  type EventPipelineSummary,
} from "./event-pipeline.ts"
import { RuntimeOutputMaterializerProjectorLive } from "./projectors.ts"
import { RuntimeOutputEventSourceLive } from "./runtime-output-source.ts"
import { StateProtocolProducerLive } from "./producer.ts"
import { StateProtocolEventSinkLive } from "./state-protocol-sink.ts"
import type {
  MaterializerSummary,
  MaterializeRuntimeOutputToSessionOptions,
} from "./types.ts"
export {
  readRuntimeJournal,
  type RuntimeJournalReadResult,
} from "./runtime-output-source.ts"

export class MaterializerRunnerError extends Schema.TaggedError<MaterializerRunnerError>()(
  "MaterializerRunnerError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const toMaterializerSummary = (
  summary: EventPipelineSummary,
): MaterializerSummary => ({
  rowsRead: summary.eventsRead,
  rowsProjected: summary.eventsProjected,
  rowsIgnored: summary.eventsIgnored,
  rowsEmpty: 0,
  rowsFailed: summary.eventsFailed,
  changesEmitted: summary.eventsWritten,
  failures: summary.failures.map(failure => ({
    sourceRuntimeEventId: failure.sourceEventId,
    reason: failure.reason,
    cause: failure.cause,
  })),
})

/**
 * firegrid-event-pipeline-materialization.PIPELINE.1
 * firegrid-event-pipeline-materialization.PIPELINE.2
 * firegrid-event-pipeline-materialization.SINK.2
 */
export const materializeRuntimeOutputToSession = Effect.fn(
  "materializeRuntimeOutputToSession",
)(function* (options: MaterializeRuntimeOutputToSessionOptions) {
  const sourceOptions = options.since === undefined
    ? {
      streamUrl: options.sourceDataPlaneStreamUrl,
      contextId: options.contextId,
    }
    : {
      streamUrl: options.sourceDataPlaneStreamUrl,
      contextId: options.contextId,
      since: options.since,
    }

  const layer = EventPipelineLive.pipe(
    Layer.provide(RuntimeOutputEventSourceLive(sourceOptions)),
    Layer.provide(RuntimeOutputMaterializerProjectorLive(options.materializer)),
    Layer.provide(StateProtocolEventSinkLive({
      streamUrl: options.targetSessionStreamUrl,
      contextId: options.contextId,
    })),
    Layer.provide(StateProtocolProducerLive),
  )

  const summary = yield* Effect.scoped(
    EventPipeline.pipe(
      Effect.flatMap(pipeline => pipeline.run),
      Effect.provide(layer),
      Effect.mapError(cause =>
        new MaterializerRunnerError({ op: "materializeRuntimeOutputToSession", cause })),
    ),
  )

  return toMaterializerSummary(summary)
})
