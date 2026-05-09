# SDD: Firegrid Event Pipeline Materialization

Date: 2026-05-09

Status: accepted for implementation spike

Spec anchors:

- `firegrid-event-pipeline-materialization.PIPELINE.1`
- `firegrid-event-pipeline-materialization.PIPELINE.2`
- `firegrid-event-pipeline-materialization.PIPELINE.3`
- `firegrid-event-pipeline-materialization.SOURCE.1`
- `firegrid-event-pipeline-materialization.SOURCE.2`
- `firegrid-event-pipeline-materialization.PROJECTOR.1`
- `firegrid-event-pipeline-materialization.PROJECTOR.2`
- `firegrid-event-pipeline-materialization.PROJECTOR.3`
- `firegrid-event-pipeline-materialization.SINK.1`
- `firegrid-event-pipeline-materialization.SINK.2`
- `firegrid-event-pipeline-materialization.SINK.3`
- `firegrid-event-pipeline-materialization.BOUNDARY.1`
- `firegrid-event-pipeline-materialization.BOUNDARY.2`
- `firegrid-event-pipeline-materialization.BOUNDARY.3`

## Problem

Tracer 002 introduced a runtime-output to session-State-Protocol
materializer. Tracer 004 introduced a Materialize provider. These are the same
shape at different layers:

```txt
source events -> interpretation strategy -> derived sink
```

The code does not yet express that shared shape. `MaterializationEngine` only
abstracts the Materialize provider/query side, while the State Protocol runner
has its own separate path. That makes it too easy to grow one-off projection
systems instead of swapping providers behind one interface.

## Decision

Use Effect services and layers for the whole event pipeline:

```txt
EventSource -> EventProjector -> EventSink -> EventPipeline
```

Names should stay plain:

- `EventSource`: where accepted durable events are read from.
- `EventProjector`: the user/provider materializer strategy.
- `EventSink`: where projected events are written.
- `EventQuery`: optional query/subscription surface for sinks that support it.
- `EventPipeline`: the runner that composes source, projector, and sink.

Do not call this abstraction an engine. Materialize is one sink/query
implementation. State Protocol is another sink implementation.

## Composition

Session state projection:

```ts
const SessionPipelineLive = EventPipelineLive.pipe(
  Layer.provide(RuntimeOutputEventSourceLive({
    streamUrl: runtimeOutputStreamUrl,
    contextId,
  })),
  Layer.provide(ExampleJsonlSessionProjectorLive),
  Layer.provide(StateProtocolEventSinkLive({
    streamUrl: sessionStateStreamUrl,
  })),
)
```

Materialize projection:

```ts
const SqlPipelineLive = EventPipelineLive.pipe(
  Layer.provide(RuntimeOutputEventSourceLive({
    streamUrl: runtimeOutputStreamUrl,
    contextId,
  })),
  Layer.provide(RawRuntimeOutputProjectorLive),
  Layer.provide(MaterializeEventSinkLive({
    sourceName: "runtime_output",
    webhookBaseUrl: "http://localhost:6874",
  })),
)
```

Provider/user strategy swap:

```ts
const AcpSessionPipelineLive = EventPipelineLive.pipe(
  Layer.provide(RuntimeOutputEventSourceLive({
    streamUrl: runtimeOutputStreamUrl,
    contextId,
  })),
  Layer.provide(AcpSessionProjectorLive),
  Layer.provide(StateProtocolEventSinkLive({
    streamUrl: sessionStateStreamUrl,
  })),
)
```

The stable seam is the projector. A user supports a new agent/provider by
providing an `EventProjector` layer. The host chooses the sink.

## Service Shape

```ts
class EventSource extends Context.Tag("firegrid/runtime/EventSource")<
  EventSource,
  {
    readonly read: Effect.Effect<ReadonlyArray<unknown>, EventSourceError>
  }
>() {}

class EventProjector extends Context.Tag("firegrid/runtime/EventProjector")<
  EventProjector,
  {
    readonly name: string
    readonly version: string
    readonly project: (
      event: unknown,
    ) => Effect.Effect<ReadonlyArray<unknown>, EventProjectorError>
  }
>() {}

class EventSink extends Context.Tag("firegrid/runtime/EventSink")<
  EventSink,
  {
    readonly writeAll: (
      events: ReadonlyArray<unknown>,
    ) => Effect.Effect<void, EventSinkError>
    readonly flush: Effect.Effect<void, EventSinkError>
  }
>() {}

class EventPipeline extends Context.Tag("firegrid/runtime/EventPipeline")<
  EventPipeline,
  {
    readonly run: Effect.Effect<EventPipelineSummary, EventPipelineError>
  }
>() {}
```

The implementation may expose typed helper constructors around these services
so call sites keep useful TypeScript inference, but service wiring should
remain Effect-native.

## Current Mappings

Existing runtime-output journal writer:

```txt
packages/runtime/src/data-plane/runtime-output/writer.ts
```

Role: producer only. It journals live runtime facts. It is not a projector and
not a sink.

Existing tracer 002 code:

```txt
packages/runtime/src/data-plane/materialization/runner.ts
packages/runtime/src/data-plane/materialization/producer.ts
packages/runtime/src/data-plane/materialization/example-jsonl-session.ts
```

Target mapping:

- retained `readRuntimeJournal(...)` becomes `RuntimeOutputEventSourceLive`;
- `exampleJsonlSessionMaterializer` becomes `ExampleJsonlSessionProjectorLive`;
- `StateProtocolProducer` becomes `StateProtocolEventSinkLive`;
- `materializeRuntimeOutputToSession(...)` becomes a compatibility wrapper over
  `EventPipeline`.

Existing tracer 004 code:

```txt
packages/runtime/src/data-plane/materialization/engines/materialize.ts
```

Target mapping:

- Materialize provider becomes `MaterializeEventSinkLive`;
- query/subscribe helpers become `MaterializeEventQueryLive` or exported query
  builders;
- the old `MaterializationEngine` name should either be deprecated or reduced
  to a backwards-compatible alias.

## Boundaries

```txt
RuntimeCaptureJournal
  live process output -> raw durable runtime-output events

RuntimeOutputEventSource
  raw durable runtime-output events -> source event array

EventProjector
  source events -> provider/user-defined projected events

EventSink
  projected events -> derived system
```

The pipeline never makes Materialize or State Protocol authoritative. Durable
Streams runtime-output rows remain the replay authority.

## Parallel Implementation Plan

Work can split safely:

1. Core lane:
   - add `event-pipeline.ts` services and runner;
   - add `RuntimeOutputEventSourceLive`;
   - wrap existing tracer 002 runner over `EventPipeline`.

2. Sink lane:
   - implement `StateProtocolEventSinkLive`;
   - implement `MaterializeEventSinkLive`;
   - keep Materialize query helpers intact.

Both lanes meet at the `EventSink` service. Tests should include one fake
source/projector/sink unit test and one compatibility test proving the existing
session materialization path still works.

