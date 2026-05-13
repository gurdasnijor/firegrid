# SDD: Effect-Native Durable Streams Production Cutover

**Status:** proposed
**Scope:** breaking stabilization wave
**Primary spec:** `effect-native-production-cutover`
**Depends on:** `effect-native-api`, `firegrid-platform-invariants`,
`effect-durable-operators`

> Note: an earlier revision listed `stream-native-runtime-loop` as a
> dependency. That feature spec, its tracer (`015`), and its production
> implementation under `packages/runtime/src/stream-native-runtime-loop/`
> were all deleted in tracer 017 (PR #158). Runtime input delivery
> now flows through `effect-durable-operators` (see
> `docs/tracers/017-effect-durable-operators.md`).

## Decision

Firegrid will use `effect-durable-streams` as the durable stream/log primitive.
The cutover is intentionally final: production code should stop using legacy
Firegrid helper families and service wrappers that were introduced while the
substrate was unsettled.

The target primitive is:

```ts
const stream = DurableStream.define({
  endpoint,
  schema,
})

yield* stream.append(row)

const rows = yield* stream.collect

const producer = yield* stream.producer({
  producerId,
})

yield* Stream.run(events, producer)
yield* producer.flush
```

Everything above that primitive should be domain code: schemas, row
constructors, folds, and focused Effect programs. Do not create a replacement
`DurableLog`, `RuntimeIngress`, or `RuntimeCaptureJournal` service to hide this
API. If code needs a durable stream, it should define the stream with its domain
schema at the boundary and compose with `Effect`, `Stream`, `Sink`, `Scope`, and
`Layer` in the ordinary Effect style.

## Motivation

Tracer 015 proved that the new client can express a Firegrid-shaped runtime
loop without a bespoke event-store service:

```txt
durable runtime ingress facts
  -> Stream fold
  -> durable delivery progress
  -> real local process stdin
  -> RuntimeJournalEvent Stream
  -> DurableStream producer
```

The next step is not compatibility. This is a greenfield repo; preserving old
helper names and wrapper services would keep the architecture hard to reason
about. The correct move is a breaking cutover that deletes the old public
surfaces and forces every caller onto the chosen primitive.

## Requirements

- `effect-native-production-cutover.RUNTIME_IO.1`
- `effect-native-production-cutover.RUNTIME_IO.2`
- `effect-native-production-cutover.RUNTIME_IO.3`
- `effect-native-production-cutover.RUNTIME_IO.4`
- `effect-native-production-cutover.MATERIALIZATION.1`
- `effect-native-production-cutover.MATERIALIZATION.2`
- `effect-native-production-cutover.MATERIALIZATION.3`
- `effect-native-production-cutover.REQUIRED_ACTION.1`
- `effect-native-production-cutover.REQUIRED_ACTION.2`
- `effect-native-production-cutover.CLIENT_APP.1`
- `effect-native-production-cutover.CLIENT_APP.2`
- `effect-native-production-cutover.CLIENT_APP.3`
- `effect-native-production-cutover.DELETION.1`
- `effect-native-production-cutover.DELETION.2`
- `effect-native-production-cutover.DELETION.3`
- `effect-native-production-cutover.DELETION.4`
- `effect-native-production-cutover.DELETION.5`
- `effect-native-production-cutover.GUARDRAILS.1`
- `effect-native-production-cutover.GUARDRAILS.2`
- `effect-native-production-cutover.GUARDRAILS.3`

## Architectural Rule

Durable stream interaction has one shape:

```txt
Schema-owned stream definition
  -> Effect/Stream/Sink operation
  -> domain row/fold/program
```

Not:

```txt
DurableStream
  -> Firegrid helper family
  -> service wrapper
  -> domain code
```

The module that owns a domain row owns the `DurableStream.define(...)` boundary
for that row. For example:

- runtime ingress owns `RuntimeIngressRowSchema`;
- runtime output owns `RuntimeJournalEventSchema` write programs;
- required actions own required-action durable fact rows;
- materialization owns its projection input/output stream definitions;
- client snapshots own their retained read stream definitions.

This keeps schema, durable stream identity, and domain interpretation close
together, and avoids a generic abstraction that must understand every row type.

## Production Module Shape

### Runtime Ingress

Target:

```txt
packages/runtime/src/runtime-ingress/
  schema.ts
  ids.ts
  rows.ts
  folds.ts
  stream.ts
  index.ts
```

`stream.ts` should expose focused functions, not a service tag:

```ts
export const appendRuntimeIngress = (options) =>
  runtimeIngressStream(options.endpoint).append(makeRequestedRow(options))

export const pendingRuntimeIngress = (options) =>
  runtimeIngressStream(options.endpoint)
    .read({ live: false })
    .pipe(Stream.runFold(...))

export const markRuntimeIngressDelivered = (options) =>
  runtimeIngressStream(options.endpoint).append(makeDeliveredRow(options))
```

Delete the production `RuntimeIngressLive` service. The host can still provide
stream URLs as ordinary program options, but it should not provide a mini
event-store service.

### Runtime Output

Target:

```txt
packages/runtime/src/runtime-output/
  rows.ts
  stream.ts
  index.ts
```

`stream.ts` should expose a focused write program over a `Stream` of output
rows/events:

```ts
export const writeRuntimeOutput = (options) =>
  Effect.scoped(Effect.gen(function* () {
    const stream = DurableStream.define({
      endpoint: options.endpoint,
      schema: RuntimeJournalEventSchema,
    })
    const producer = yield* stream.producer({
      producerId: runtimeOutputProducerId(options),
      lingerMs: options.lingerMs,
    })
    yield* Stream.run(options.events, producer)
    yield* producer.flush
  }))
```

Delete `RuntimeCaptureJournal` and `RuntimeCaptureJournalLive`. Runtime workflow
code should call `writeRuntimeOutput` or construct the output event stream and
run it through the producer directly.

### Runtime Context Workflow

The workflow should depend on:

- runtime context state services;
- sandbox/provider services;
- stream-native ingress/output functions;
- workflow engine services.

It should not depend on:

- `RuntimeCaptureJournal`;
- `RuntimeIngress`;
- log/producer helper services;
- compatibility adapters.

### Materialization

Materialization sources should read runtime-output facts through
`DurableStream.define(...).read/collect`. State Protocol sinks should write
changes through `DurableStream.producer`.

`StateProtocolWriter` may remain only if it expresses a real domain-level writer
for State Protocol change streams. It must not wrap legacy
`openDurableStreamProducer`.

### Required Actions

Required-action storage should use the same primitive:

```ts
const stream = DurableStream.define({
  endpoint,
  schema: RequiredActionRowSchema,
})
```

This is still not the final workflow-reactor architecture. The cutover only
removes legacy durable stream helpers from required-action row storage so future
operator work does not build on stale substrate code.

### Client, Apps, and Scenarios

Client snapshot reads and scenario setup/assertions should use
`effect-durable-streams` directly.

Scenarios may continue using durable-streams test infrastructure:

```ts
// Historical examples imported a Firegrid-owned Durable Streams test helper here.
```

But they should not use `@firegrid/durable-streams/log` or
`@firegrid/durable-streams/producer`.

## Delete List

Remove or make non-importable:

```txt
packages/durable-streams/src/DurableStreamLog.ts
packages/durable-streams/src/log.ts
packages/durable-streams/src/DurableStreamProducer.ts
packages/durable-streams/src/producer.ts
```

Remove exports for:

```txt
appendJson
readRetainedJson
ensureJsonDurableStream
makeJsonDurableStream
openDurableStreamProducer
```

Remove production runtime exports for:

```txt
RuntimeCaptureJournal
RuntimeCaptureJournalLive
RuntimeIngressLive
RuntimeIngressUnavailableLive
```

`RuntimeIngress` row schemas/types may remain. The service/layer wrapper should
not.

## Static Guardrails

Add dependency/lint guardrails that fail on new imports of:

```txt
@firegrid/durable-streams/log
@firegrid/durable-streams/producer
```

Add source checks that fail on new production references to:

```txt
appendJson
readRetainedJson
openDurableStreamProducer
RuntimeCaptureJournal
RuntimeCaptureJournalLive
RuntimeIngressLive
RuntimeIngressUnavailableLive
```

Historical docs may mention old names if clearly historical, but current
architecture docs should point at `effect-durable-streams`.

## Cutover Work Scope

This should be one stabilization PR or one tightly coordinated branch. Splitting
into tiny compatibility PRs will leave the repo in a hybrid state and recreate
the problem this cutover is meant to solve.

Owned areas:

```txt
packages/runtime/src/runtime-ingress/**
packages/runtime/src/runtime-output/**
packages/runtime/src/runtime-context/**
packages/runtime/src/runtime-host/**
packages/runtime/src/materialization/**
packages/runtime/src/required-action/**
packages/client/src/**
apps/flamecast/src/**
scenarios/firegrid/src/**
packages/durable-streams/src/**
dependency/lint scripts
current architecture docs
```

## Acceptance

All production and scenario durable stream log/producer interactions use
`effect-durable-streams`.

This search should have no production/source matches:

```sh
rg "appendJson|readRetainedJson|openDurableStreamProducer|@firegrid/durable-streams/log|@firegrid/durable-streams/producer|RuntimeCaptureJournal|RuntimeCaptureJournalLive|RuntimeIngressLive|RuntimeIngressUnavailableLive" packages apps scenarios
```

Run at minimum:

```sh
pnpm --filter effect-durable-streams run typecheck
pnpm --filter effect-durable-streams run test
pnpm --filter effect-durable-streams-state run typecheck
pnpm --filter effect-durable-streams-state run test
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/client run typecheck
pnpm --filter @firegrid/client run test
pnpm --filter @firegrid/flamecast run typecheck
pnpm --filter @firegrid/flamecast run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-001
pnpm --filter @firegrid/scenario-firegrid test -- tracer-002
pnpm --filter @firegrid/scenario-firegrid test -- tracer-007
pnpm --filter @firegrid/scenario-firegrid test -- tracer-008
pnpm --filter @firegrid/scenario-firegrid test -- tracer-009
pnpm --filter @firegrid/scenario-firegrid test -- tracer-011
pnpm --filter @firegrid/scenario-firegrid test -- tracer-012
# tracer-015 (stream-native-runtime-loop validation) was deleted in
# tracer 017. Runtime input delivery is now validated by tracer-017.
pnpm --filter @firegrid/scenario-firegrid test -- tracer-016
pnpm --filter @firegrid/scenario-firegrid test -- tracer-017
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
pnpm run check:docs
pnpm run check:specs
git diff --check
pnpm exec acai push --all --product firegrid
```

## Non-Goals

- Do not redesign the workflow engine.
- Do not redesign required-action/reactive-operator semantics.
- Do not introduce a runtime host topology change unless removing old Layer
  wiring requires it.
- Do not create compatibility aliases.
- Do not keep old helper subpaths alive for tests.

## Follow-Up

After this lands, the next workflow-reactor and workflow-backed tool tracers
should treat `effect-durable-streams` as the substrate primitive. They should
not introduce a new durable stream wrapper unless a fresh tracer proves the
primitive is insufficient.
