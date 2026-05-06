# SDD: Firegrid Observability

Date: 2026-05-06

Status: Proposal, docs-only

Future spec:
`features/firegrid/firegrid-observability.feature.yaml`

## Purpose

Firegrid sits in the durable data plane for operations, events, waits,
subscribers, and runtime execution. That makes it the right layer to connect
trace context across work that product runtimes currently observe piecemeal.

This SDD proposes a product-neutral observability layer for Firegrid. It should
capture causal relationships across:

- client operation send/result/observe;
- runtime handler execution;
- EventPlane emits and projection reads;
- EventStream appends and replay/materialization;
- RunWait suspension and resume;
- durable subscriber attempts, retries, and terminalization;
- operation terminal results and typed failures.

The goal is connected substrate spans and metadata, not product telemetry
policy.

## Problem Statement

Products such as Flamecast already have tracing helpers, but they do not sit at
the durable boundary. A session can cross:

- a browser or Worker request;
- a Firegrid client send;
- a Node runtime handler;
- an EventPlane request row;
- a durable wait;
- an external callback;
- a projection-match wake;
- event replay in the UI;
- subscriber delivery or dead-letter handling.

Without a shared substrate observability model, those edges become disconnected
logs or product-specific trace stitching.

Firegrid can provide the generic metadata and span boundaries needed to connect
the execution graph while leaving product names, provider policy, and exporters
downstream.

## Design Principle

Trace metadata is context, not authority.

```txt
Trace context may explain why a durable fact exists.
It must never decide who may read, write, resume, or terminalize that fact.
```

Correctness must not depend on trace metadata. Missing trace metadata must not
change durable behavior.

Firegrid should integrate with Effect tracing first. Host applications can
provide OpenTelemetry exporters through their own Layers; Firegrid should expose
substrate spans and durable correlation metadata without owning exporter,
sampling, retention, or dashboard policy.

## Ownership Boundary

Firegrid owns:

- substrate span names and stable substrate attributes;
- correlation and causation metadata keys;
- producer, runtime, subscriber, operation, stream, cursor, row, attempt, and
  terminal status attributes;
- trace context encode/decode helpers;
- propagation through app-owned row metadata;
- typed error/terminal correlation.

Products own:

- business span names;
- product attributes;
- tenant/auth identity and policy;
- customer-data redaction policy;
- provider/vendor trace integration;
- export backends, retention, sampling, and dashboards.

## Metadata Model

Durable records should have a product-neutral metadata slot. The observability
layer can standardize optional keys such as:

- correlation id;
- causation id;
- producer id;
- runtime id;
- subscriber id;
- operation id or handle id;
- descriptor name;
- row key or event key;
- stream identity;
- cursor boundary;
- attempt number;
- traceparent;
- tracestate;
- baggage.

These keys are optional and best-effort. They should be safe to copy through
durable rows, but they must not carry secrets.

`traceparent`, `tracestate`, and `baggage` should use W3C Trace Context format.
Firegrid should rely on host-provided propagators where possible rather than
hand-parsing vendor trace formats in core packages.

If a metadata value might contain secret material, implementation should either
reject it from Firegrid metadata or represent it with Effect `Redacted` until it
is deliberately converted to a safe public value. Durable metadata and span
attributes should be treated as potentially visible operational data.

## Span Boundaries

The first implementation should define substrate span boundaries for:

- client send/call/result/observe;
- EventStream append/read/replay/live-tail;
- EventPlane emit/projection read/projection wait;
- runtime boot and handler invocation;
- RunWait suspend and resume;
- projection-match subscriber evaluation and wake;
- durable subscriber claim, side effect attempt, retry, completion, and
  dead-letter;
- operation terminalization.

Span names should be Firegrid substrate names, not product names. Product code
can wrap them in business spans if desired.

## Error and Terminal Correlation

Typed expected errors and terminal operation failures should attach substrate
context:

- operation descriptor;
- row or event descriptor;
- run/operation id;
- stream cursor when available;
- subscriber id and attempt when relevant;
- error class;
- terminal status.

This should help answer whether a failure happened during read, decode, wait,
subscriber side effect, retry exhaustion, handler failure, or operation
terminalization.

Product-domain errors remain product-domain errors. Firegrid should not define
provider unavailable, permission denied, model unsupported, sandbox failed, or
prompt not live as substrate error variants.

## Package Shape

The observability layer should be composable without creating product coupling.

Potential package placement:

- core metadata and attribute types in a curated public Firegrid surface;
- runtime span Layers in `@firegrid/runtime`;
- browser-safe trace context helpers in `@firegrid/client` only if they do not
  pull runtime or Node-only dependencies;
- no dependency from browser-safe client roots to `@firegrid/runtime`.

Implementation must preserve existing package boundary rules:

- no `@firegrid/substrate/kernel` in app code;
- no runtime dependency in browser-safe client entrypoints;
- no dist-internal imports;
- no product telemetry package dependency in Firegrid core;
- no direct dependency on `@effect/opentelemetry` from Firegrid core packages
  unless a later spec proves a product-neutral adapter is needed.

## Effect Tracing Direction

Firegrid should build on Effect tracing first. The implementation posture is:

- use `Effect.withSpan(name, { attributes, kind, links })` for substrate span
  boundaries;
- use `Effect.annotateCurrentSpan` for stable Firegrid attributes;
- rely on Effect logs inside a span becoming span events when the host tracing
  Layer enables that behavior;
- let downstream runtimes provide `@effect/opentelemetry` Layers and exporters;
- keep direct OpenTelemetry SDK wiring out of browser-safe Firegrid client
  entrypoints.

The Firegrid code should be written so tracing is a wrapper around existing
Effect programs. Adding or removing the tracing Layer must not change the
operation result, durable row shape, terminalization path, retry behavior, or
authority checks.

Canonical static-attribute shape:

```ts
import { Effect } from "effect"

type FiregridSpanAttributes = Record<string, string | number | boolean>

const withFiregridSpan =
  (name: string, attributes: FiregridSpanAttributes) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.withSpan(name, {
        attributes,
        kind: "internal",
      }),
    )
```

Dynamic attributes that are only known after an operation starts should still
use `Effect.annotateCurrentSpan` inside the span:

```ts
const sendWithTrace = client.send(operation, input).pipe(
  Effect.tap((handle) =>
    Effect.annotateCurrentSpan({
      [FiregridTraceAttribute.operationHandleId]: handle.id,
    }),
  ),
  Effect.withSpan("firegrid.client.operation.send", {
    kind: "client",
    attributes: {
      [FiregridTraceAttribute.operationDescriptor]: operation.name,
    },
  }),
)
```

The point is the layering: spans wrap existing Effects, static attributes go
into `withSpan` options, and dynamic attributes annotate the active span.

## Span Names and Attributes

Use stable substrate span names. Product code can nest business spans above
them, but Firegrid spans should be recognizable across products.

| Span | Kind | First attributes |
| --- | --- | --- |
| `firegrid.client.operation.send` | client | operation descriptor, client id when present, handle id after send |
| `firegrid.client.operation.observe` | client | operation descriptor, handle id, observed state tag |
| `firegrid.client.operation.result` | client | operation descriptor, handle id, terminal status |
| `firegrid.event_stream.append` | producer | stream descriptor, event type, event key, producer id |
| `firegrid.event_stream.read` | consumer | stream descriptor, cursor boundary, replay/live mode |
| `firegrid.event_plane.emit` | producer | plane descriptor, row family, row key, producer id |
| `firegrid.projection.read` | internal | plane descriptor, projection name, cursor boundary |
| `firegrid.projection.until` | internal | plane descriptor, projection name, predicate label, timeout |
| `firegrid.runtime.boot` | internal | runtime id, process role, connection kind |
| `firegrid.runtime.handler` | server | operation descriptor, runtime id, run id |
| `firegrid.run_wait.suspend` | internal | trigger type, wait id, operation descriptor, run id |
| `firegrid.run_wait.resume` | internal | trigger type, wait id, completion status |
| `firegrid.subscriber.attempt` | consumer | subscriber id, attempt number, claim id when present |
| `firegrid.subscriber.terminalize` | producer | subscriber id, attempt number, terminal status |

Attribute names should be explicit and namespaced, for example:

```ts
const FiregridTraceAttribute = {
  operationDescriptor: "firegrid.operation.descriptor",
  operationHandleId: "firegrid.operation.handle_id",
  runId: "firegrid.run.id",
  runtimeId: "firegrid.runtime.id",
  streamDescriptor: "firegrid.stream.descriptor",
  eventType: "firegrid.event.type",
  eventKey: "firegrid.event.key",
  planeDescriptor: "firegrid.event_plane.descriptor",
  rowFamily: "firegrid.event_plane.row_family",
  rowKey: "firegrid.event_plane.row_key",
  cursor: "firegrid.cursor",
  subscriberId: "firegrid.subscriber.id",
  attempt: "firegrid.attempt",
  status: "firegrid.status",
  errorTag: "firegrid.error.tag",
} as const
```

The concrete names should be ratified in
`features/firegrid/firegrid-observability.feature.yaml` before implementation.
Do not encode product terms such as session, provider, model, tenant, prompt,
permission, or tool in Firegrid-native attribute names.

## Implementation Sketch

A likely implementation path follows. These sketches are intentionally small:
they show where instrumentation belongs, not final API names.

### 1. Trace Metadata Helpers

Start with a small metadata shape that can be carried through app-owned row
metadata and operation/event envelopes where those envelopes already have a
metadata slot.

```ts
export interface FiregridTraceMetadata {
  readonly correlationId?: string
  readonly causationId?: string
  readonly producerId?: string
  readonly traceparent?: string
  readonly tracestate?: string
  readonly baggage?: string
}

export const FiregridTraceMetadata = {
  empty: {} satisfies FiregridTraceMetadata,
  merge: (
    parent: FiregridTraceMetadata | undefined,
    next: FiregridTraceMetadata,
  ): FiregridTraceMetadata => ({ ...parent, ...next }),
}
```

This helper should not know product identities or secrets. It is a carrier for
correlation, not an access-control object.

### 2. Client Operations

Client operations should create spans around send/result/observe without
changing the public client result types.

```ts
const sendWithTrace = <I, O, E>(
  operation: Operation<I, O, E>,
  input: I,
) =>
  client.send(operation, input).pipe(
    Effect.tap((handle) =>
      Effect.annotateCurrentSpan({
        [FiregridTraceAttribute.operationHandleId]: handle.id,
      }),
    ),
    Effect.withSpan("firegrid.client.operation.send", {
      kind: "client",
      attributes: {
        [FiregridTraceAttribute.operationDescriptor]: operation.name,
      },
    }),
  )
```

`observe` and `result` should annotate the handle id and observed state or
terminal status. They must not expose terminal-row authority to the caller.

### 3. Runtime Handler Invocation

Runtime instrumentation should wrap the handler function that is already
registered through `Firegrid.handler` and composed through
`Firegrid.composeRuntime`.

```ts
const instrumentHandler =
  <I, O, E>(
    operation: Operation<I, O, E>,
    runId: string,
    handler: (input: I) => Effect.Effect<O, E>,
  ) =>
  (input: I) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        [FiregridTraceAttribute.operationDescriptor]: operation.name,
        [FiregridTraceAttribute.runId]: runId,
      })
      return yield* handler(input)
    }).pipe(Effect.withSpan("firegrid.runtime.handler"))
```

Expected operation failures should remain typed `Effect.fail` values. Effect
tracing already records failed Effects as errored spans with exception events
when tracing is active. Firegrid's substrate-specific contribution is adding
stable attributes such as `firegrid.error.tag`; terminalization still happens
through handler return or `Effect.fail`, not through trace state.

### 4. EventPlane and EventStream

EventPlane producers and EventStream append/read paths should attach descriptor,
row/event key, cursor, and producer context.

```ts
const emitWithTrace = <E, R>(
  rowFamily: string,
  rowKey: string,
  emit: Effect.Effect<void, E, R>,
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      [FiregridTraceAttribute.rowFamily]: rowFamily,
      [FiregridTraceAttribute.rowKey]: rowKey,
    })
    return yield* emit
  }).pipe(Effect.withSpan("firegrid.event_plane.emit"))
```

Reads should distinguish replay and live-tail mode in span attributes. Decode
failures should annotate descriptor/key/cursor context before returning the
typed expected error.

### 5. RunWait Suspend and Resume

RunWait should create a span when a handler durably suspends and a related span
when the wait wakes. The wake span should link by durable identifiers carried in
metadata, not by in-memory references.

```ts
const waitWithTrace = <A, E, R>(
  waitId: string,
  triggerType: string,
  wait: Effect.Effect<A, E, R>,
) =>
  wait.pipe(
    Effect.withSpan("firegrid.run_wait.suspend", {
      kind: "internal",
      attributes: {
        "firegrid.wait.id": waitId,
        "firegrid.wait.trigger_type": triggerType,
      },
    }),
  )
```

If the operation process restarts, the resumed handler should still have enough
durable metadata to correlate the resume span with the prior suspend span.
Where a prior suspend span context is available from durable `traceparent`
metadata, the resume span should use an OpenTelemetry span link rather than
only matching attributes:

```ts
const resumeWithTrace = <A, E, R>(
  waitId: string,
  suspendLink: SpanLink | undefined,
  resume: Effect.Effect<A, E, R>,
) =>
  resume.pipe(
    Effect.withSpan("firegrid.run_wait.resume", {
      kind: "internal",
      links: suspendLink ? [suspendLink] : [],
      attributes: {
        "firegrid.wait.id": waitId,
      },
    }),
  )
```

Final link syntax depends on the repo's pinned Effect/OpenTelemetry versions.
The contract is that suspend/resume can be connected by trace context stored in
durable metadata, not by process-local parentage.

### 6. Durable Subscribers

Subscriber instrumentation should wait for the durable subscriber spec to land,
then cover:

- claim-before-side-effect;
- attempt number;
- side-effect outcome;
- retry scheduling;
- terminal success/failure;
- dead-letter write.

The span around an attempt should never be the durable acknowledgement. Durable
completion still requires the subscriber's completion row.

### 7. Tests and Conformance

Implementation tests should prove three classes of behavior:

1. Instrumentation is non-semantic: the same program succeeds, fails, retries,
   and terminalizes identically with and without tracing Layers.
2. Package boundaries hold: browser-safe imports do not pull
   `@firegrid/runtime`, Node-only tracing SDKs, kernel imports, or exporters.
3. Correlation is present when metadata is supplied: spans include descriptor,
   handle, run, row/event, cursor, subscriber, attempt, and status attributes
   where those values exist.

The test harness can use an in-memory or test tracer if available in the pinned
Effect/OpenTelemetry versions. If not, assert the Firegrid helper calls at the
Effect boundary and reserve exporter-specific tests for product runtimes.

Implementation should also consider a centralized runtime instrumentation layer
or middleware at the `Firegrid.composeRuntime` boundary. Per-handler wrappers
are useful sketches, but centralized wrapping may keep span naming and attribute
policy consistent across all handlers/subscribers.

### 8. Incremental PR Slices

Do not land every span in one PR. A practical sequence is:

1. substrate metadata types and attribute constants;
2. client send/result/observe spans;
3. runtime boot/handler spans;
4. EventStream read/append spans;
5. EventPlane emit/projection read spans;
6. RunWait suspend/resume spans;
7. durable subscriber spans after the durable subscriber feature lands.

Each slice should cite the observability ACIDs it implements and keep behavior
changes out of the same PR.

## Optional Durable Trace Rows

Existing Firegrid specs already treat `durable.trace`-style rows as optional
observability data, not authority. If this proposal later needs durable trace
rows, they should remain a read/debug materialization:

- they may record span/correlation summaries;
- they may help rebuild a trace view after process restart;
- they must not decide wait eligibility, claim ownership, terminal state, or
  authorization;
- they must not contain secrets or product payloads unless the product chooses
  to write its own product-owned observability rows.

This lane should first prove Effect span propagation before adding durable trace
records.

Production tracing may be sampled. Firegrid must not rely on spans as the only
copy of a correctness-critical identifier. If a correlation id is needed after
restart or replay, it belongs in durable row metadata first and can also be
mirrored into span attributes.

The implementation should be incremental. The spec should not require every
span to land in one PR.

Earlier implementation checklist, retained as a compact index:

1. Define substrate metadata keys and typed attribute helpers.
2. Add trace context encode/decode helpers for durable row metadata.
3. Add Effect span boundaries around client send/result/observe.
4. Add runtime handler and RunWait suspend/resume spans.
5. Add EventPlane/EventStream emit/read spans.
6. Add durable subscriber attempt/retry/completion/dead-letter spans after the
   durable subscriber feature lands.
7. Add tests proving trace metadata propagation is optional and not required
   for correctness.
8. Add package-boundary tests proving browser-safe entrypoints do not import
   runtime or Node-only observability dependencies.

## Flamecast Fit

Flamecast currently has local tracing helpers around runtime work. A Firegrid
observability layer would let Flamecast connect those product spans to durable
substrate spans:

- session create request to Firegrid operation send;
- operation handler to provider request row;
- provider callback ingest to projection wake;
- RunWait resume to terminal result;
- EventStream replay to web UI observation;
- webhook delivery retries to dead-letter records.

Flamecast still owns span naming, WorkOS/org attributes, provider-specific
correlation, redaction, export backend, and retention.

## Non-Goals

This proposal does not define:

- product span names;
- tenant/auth identity;
- authorization decisions;
- provider telemetry policy;
- OpenTelemetry exporter configuration;
- sampling policy;
- secret redaction policy;
- provider-specific trace context formats;
- billing or usage analytics.

## Review Checklist

Future specs and implementation PRs should prove:

- trace metadata is optional;
- trace metadata is never used as authorization or business identity;
- product attributes remain downstream;
- no secrets are written to durable metadata;
- potential secret-like values are rejected, redacted, or converted before they
  become durable metadata or span attributes;
- browser-safe packages do not import runtime/Node observability modules;
- Firegrid core packages do not depend directly on `@effect/opentelemetry`
  unless a later spec explicitly adds that adapter boundary;
- substrate span names and attributes are stable and product-neutral;
- terminal/errors correlate to operation, descriptor, row/cursor, subscriber,
  and attempt context when available;
- missing trace context does not change durable behavior.

## Open Decisions

1. Attribute naming:
   Decide the canonical prefix and exact attribute names before implementation.

2. Package placement:
   Decide which helpers belong in client, runtime, substrate, or a new public
   subpath.

3. OTel integration:
   Firegrid should integrate through Effect observability first. Direct
   OpenTelemetry exporter configuration should remain downstream unless a later
   spec proves a product-neutral need.

4. Subscriber timing:
   Subscriber spans should probably wait for the durable subscriber spec to
   land so the attempt/completion/dead-letter vocabulary is stable.

5. Attribute schemas:
   Decide whether substrate span attributes are validated by Schema per span
   name or remain typed constants with package-boundary tests.

6. Runtime middleware:
   Decide whether runtime handler spans are wrapped at each handler registration
   or centrally as runtime middleware applied by `Firegrid.composeRuntime`.
