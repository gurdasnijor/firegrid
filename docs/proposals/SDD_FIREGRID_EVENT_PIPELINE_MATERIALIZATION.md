# SDD: Firegrid Event Pipeline Materialization

Date: 2026-05-09

Status: accepted architecture

Spec anchors:

- `firegrid-event-pipeline-materialization.PIPELINE.1`
- `firegrid-event-pipeline-materialization.PIPELINE.2`
- `firegrid-event-pipeline-materialization.PIPELINE.3`
- `firegrid-event-pipeline-materialization.PIPELINE.4`
- `firegrid-event-pipeline-materialization.SOURCE.1`
- `firegrid-event-pipeline-materialization.SOURCE.2`
- `firegrid-event-pipeline-materialization.PROJECTOR.1`
- `firegrid-event-pipeline-materialization.PROJECTOR.2`
- `firegrid-event-pipeline-materialization.PROJECTOR.3`
- `firegrid-event-pipeline-materialization.PROJECTOR.4`
- `firegrid-event-pipeline-materialization.SINK.1`
- `firegrid-event-pipeline-materialization.SINK.2`
- `firegrid-event-pipeline-materialization.SINK.3`
- `firegrid-event-pipeline-materialization.BOUNDARY.1`
- `firegrid-event-pipeline-materialization.BOUNDARY.2`
- `firegrid-event-pipeline-materialization.BOUNDARY.3`
- `firegrid-event-pipeline-materialization.BOUNDARY.4`

## Decision

Materialization in Firegrid is an Effect service pipeline:

```txt
runtime-output journal
  -> EventSource
  -> EventProjector
  -> EventSink
  -> EventPipeline
  -> derived system
```

There is no compatibility layer for tracer-era "materializer runner" APIs.
This project is greenfield, so the package should read in the target
architecture vocabulary only.

## Vocabulary

- `EventSource`: reads accepted durable source events.
- `EventProjector`: interprets source events into derived event/change data.
- `EventSink`: writes projected events to a derived system.
- `EventPipeline`: composes the source, projector, and sink and returns one
  `EventPipelineSummary`.
- `MaterializeProvider`: provisions Materialize targets and provides
  query/subscribe/ingest operations. It is not an event-pipeline engine.
- `StateProtocolWriter`: sink-internal writer over Durable Streams State
  Protocol. It is not the public pipeline abstraction.

Tracer-era wrapper and engine names are intentionally not exported. The public
package vocabulary is source, projector, sink, pipeline, provider, and writer.

## Source Layout

```txt
packages/runtime/src/data-plane/materialization/
  event-pipeline.ts
  runtime-output-source.ts
  projectors/
    runtime-output-session-projector.ts
    index.ts
  sinks/
    state-protocol/
      session-state-change.ts
      state-protocol-sink.ts
      state-protocol-writer.ts
      index.ts
    materialize/
      materialize-sink.ts
      index.ts
    index.ts
  materialize/
    materialize-types.ts
    materialize-provider.ts
    index.ts
  session-pipeline.ts
  materialize-pipeline.ts
  index.ts
```

The root `index.ts` exports the canonical surface:

```ts
export * from "./event-pipeline.ts"
export * from "./runtime-output-source.ts"
export * from "./projectors/index.ts"
export * from "./sinks/index.ts"
export * from "./materialize/index.ts"
export * from "./session-pipeline.ts"
export * from "./materialize-pipeline.ts"
```

## Projector Result

Projectors return a tagged result so a source event is unambiguously one of:

```ts
type EventProjectorResult<Event> =
  | { readonly _tag: "Projected"; readonly events: ReadonlyArray<Event> }
  | { readonly _tag: "Ignored"; readonly reason?: string }
  | { readonly _tag: "Failed"; readonly failures: ReadonlyArray<EventPipelineFailure> }
```

The pipeline does not accept a mixed "events plus failures" result. That keeps
counts and sink writes truthful.

## Summary

`EventPipelineSummary` is the only summary type:

```ts
type EventPipelineSummary = {
  readonly sourceEventsRead: number
  readonly sourceEventsProjected: number
  readonly sourceEventsIgnored: number
  readonly sourceEventsFailed: number
  readonly sinkEventsWritten: number
  readonly projector: EventProjectorIdentity
  readonly failures: ReadonlyArray<EventPipelineFailure>
}
```

`sinkEventsWritten` is reported by the sink after its write path accepts and
flushes the batch. It is not inferred from projector output length.

## Session Projection

Session state projection is just a named EventPipeline composition:

```ts
const SessionProjectionPipelineLive = (options: SessionProjectionOptions) =>
  EventPipelineLive.pipe(
    Layer.provide(RuntimeOutputEventSourceLive({
      streamUrl: options.runtimeOutputStreamUrl,
      contextId: options.contextId,
      since: options.since,
    })),
    Layer.provide(RuntimeOutputSessionProjectorLive),
    Layer.provide(StateProtocolEventSinkLive({
      streamUrl: options.sessionStateStreamUrl,
      contextId: options.contextId,
    })),
    Layer.provide(StateProtocolWriterLive),
  )
```

The helper `runSessionProjection(options)` returns `EventPipelineSummary`.

## Materialize Projection

Materialize provisioning/querying lives in `MaterializeProvider`. The
Materialize sink adapts a pre-provisioned target to the common `EventSink`
interface:

```ts
const target = yield* materialize.provisionRuntimeOutputProjection({
  sourceName: "runtime_output",
  webhookBaseUrl: "http://localhost:6874",
})

const MaterializeRuntimeOutputPipelineLive = EventPipelineLive.pipe(
  Layer.provide(RuntimeOutputEventSourceLive({
    streamUrl: runtimeOutputStreamUrl,
    contextId,
  })),
  Layer.provide(IdentityEventProjectorLive({
    name: "runtime-output-materialize",
    version: "1",
  })),
  Layer.provide(MaterializeEventSinkLive({ target })),
)
```

The helper `runMaterializeRuntimeOutputProjection(options)` returns
`EventPipelineSummary`.

## Boundaries

Runtime-output rows remain the durable source of truth. State Protocol streams
and Materialize tables/views are derived outputs.

The runtime-output writer is a producer only. It does not import or provide
`EventProjector`, `EventSink`, `StateProtocolWriter`, or `MaterializeProvider`.

State Protocol and Materialize implementations sit behind `EventSink`, except
for provider-specific provisioning/querying APIs exposed by
`MaterializeProvider`.
