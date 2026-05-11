# 015: Stream-Native Runtime Loop Validation

## Goal

Validate that the Effect-native Durable Streams client from PR #148 can express
a Firegrid runtime loop directly as Effect programs:

```txt
durable runtime ingress rows
  -> Effect Stream/fold
  -> durable delivery progress
  -> real local process stdin
  -> durable runtime-output rows through producer Sink
```

This is intentionally not a migration of `RuntimeIngress` or
`RuntimeCaptureJournal`. The point is higher signal than a service rewrite: prove
that a new production package path can avoid those service shapes entirely while
still preserving Firegrid's durable semantics.

## Requirements

- `stream-native-runtime-loop.LOOP.1`
- `stream-native-runtime-loop.LOOP.2`
- `stream-native-runtime-loop.LOOP.3`
- `stream-native-runtime-loop.LOOP.4`
- `stream-native-runtime-loop.LOOP.5`
- `stream-native-runtime-loop.SURFACE.1`
- `stream-native-runtime-loop.SURFACE.2`
- `stream-native-runtime-loop.SURFACE.3`
- `stream-native-runtime-loop.SURFACE.4`
- `stream-native-runtime-loop.SCENARIO.1`
- `stream-native-runtime-loop.SCENARIO.2`
- `stream-native-runtime-loop.SCENARIO.3`
- `stream-native-runtime-loop.SCOPE.1`
- `stream-native-runtime-loop.SCOPE.2`
- `stream-native-runtime-loop.SCOPE.3`

## Why This Is The Right Validation

The existing code already proves why a better substrate surface is needed:

- `packages/runtime/src/runtime-ingress/service.ts` reads retained JSON, decodes
  by hand, folds pending/delivered state, appends rows, and exposes that as a
  service.
- `packages/runtime/src/runtime-output/writer.ts` exists mostly to turn process
  chunks into a scoped `IdempotentProducer` lifecycle.
- `packages/durable-streams/src/DurableStreamLog.ts` and
  `packages/durable-streams/src/DurableStreamProducer.ts` split one-shot reads,
  retained reads, and producer lifecycle into separate helper families.

Rewriting one of those services in place would mostly test import churn. This
tracer instead builds the smallest Firegrid-shaped runtime loop from the locked
Effect-native Durable Streams API:

- `DurableStream.read(...)` / `DurableStream.collect(...)` /
  `DurableStream.snapshotThenFollow(...)` for observation.
- `DurableStream.producer(...)` as a `Sink`.
- `DurableStream.append(...)` for one durable progress fact.
- `Schema` at the wire boundary.
- `HttpClient` provided at the process/scenario edge.

If this path still needs a Firegrid-specific service wrapper, the abstraction is
not yet good enough for downstream workflow-reactor work.

## Proposed Production Surface

Add one focused experimental program under runtime, for example:

```txt
packages/runtime/src/stream-native-runtime-loop/
  index.ts
  run.ts
  rows.ts
  folds.ts
```

The public surface should be a function, not a service tag:

```ts
const summary = yield* runStreamNativeRuntimeLoop({
  ingressEndpoint,
  outputEndpoint,
  contextId,
  subscriberId: "local-process",
  provider: localProcessFixture({ command, args }),
})
```

The function may require `HttpClient.HttpClient`, `CommandExecutor`, and
`Scope.Scope` in `R`. That is the desired Effect shape: capabilities are
provided at the edge, while per-run values are ordinary arguments.

The implementation should keep durable-stream-specific work localized to the
program and should keep domain work plain:

- row constructors for requested/delivered/runtime-output facts;
- pure fold for "pending ingress for this subscriber";
- pure mapping from process stdout/stderr chunks to runtime-output facts;
- stream/sink plumbing at the edge of the program.

## Target Flow

```txt
1. Scenario appends one durable ingress requested row.
2. Program reads retained ingress rows through the Effect-native stream API.
3. Program folds pending rows for `{ contextId, subscriberId }`.
4. Program appends or produces the delivered row before writing to stdin.
5. Program starts a real local process fixture and writes exactly one prompt to stdin.
6. Program captures stdout/stderr chunks and writes runtime-output facts through a producer Sink.
7. Program exits and returns a summary.
8. Scenario reads retained ingress and output streams and asserts:
   - requested row exists;
   - delivered row exists;
   - stdout row contains the prompt evidence;
   - re-running the program does not produce a second provider-visible stdin delivery.
```

This order preserves the current tracer-012 idempotency policy: durable delivery
progress is recorded before the provider-visible side effect so a retry cannot
duplicate stdin delivery.

## Scenario Proof

Add:

```txt
scenarios/firegrid/src/tracer-015.test.ts
```

The scenario must be high fidelity:

- Use real Durable Streams test infrastructure.
- Use a real local process fixture that reads stdin and writes stdout.
- Use the production package program from `@firegrid/runtime`.
- Provide `HttpClient` and Node process capabilities through real layers.
- Assert retained durable facts, not only returned summary values.

The test name should include a small ACID set, for example:

```txt
stream-native-runtime-loop.LOOP.1 stream-native-runtime-loop.LOOP.2
stream-native-runtime-loop.LOOP.3 stream-native-runtime-loop.LOOP.4
stream-native-runtime-loop.SCENARIO.1 stream-native-runtime-loop.SCENARIO.3
```

## What This Proved

This tracer proves that the Effect-native Durable Streams API can express the
runtime-loop shape without adding another Firegrid event-store service:

- retained runtime ingress is read through `DurableStream.define(...).read({ live: false })`
  and folded with Stream combinators;
- delivery progress is durably appended before provider-visible stdin;
- local process stdout/stderr are mapped into a `Stream` of
  `RuntimeJournalEventSchema` rows;
- runtime-output rows are written through a scoped Durable Streams producer;
- re-running the program after delivery progress does not duplicate the prompt.

The production path is a focused program function plus schemas, row
constructors, and pure folds. It does not introduce a `RuntimeIngress`-like
service, `RuntimeCaptureJournal`-like service, host topology field, workflow
endpoint, service registry, or custom durable-log object protocol.

## What This Did Not Prove

This tracer intentionally does not prove concurrent multi-worker claim
semantics. The validation records delivery before stdin and proves restart
idempotency for a single runner/subscriber, but it does not coordinate multiple
workers racing for the same ingress row. That remains a future claim/operator
question, not something to infer from this validation.

The producer API was usable, but counting rows while writing exposed a small
ergonomic wrinkle: `Stream.run(events, producer)` is the most direct Sink shape,
but it returns `void`, so the validation uses `Stream.runFoldEffect` with
`producer.append(...)` and an explicit `producer.flush` to return a summary.
That is acceptable for this proof, but it is useful feedback for the accepted
Effect-native API surface if count/ack summaries become common.

## Non-Goals

- Do not migrate `FiregridRuntimeHostLive`.
- Do not migrate the client launch API.
- Do not introduce required-action, workflow-operator, or tool semantics.
- Do not add a new durable-log object protocol.
- Do not add a new runtime host topology field.
- Do not add a new service registry or composition root.
- Do not use Materialize or State Protocol.

## Rejection Criteria

The spike should be considered a failed validation if the implementation needs
any of these to stay understandable:

- a new `RuntimeIngress`-like service tag;
- a new `RuntimeCaptureJournal`-like service tag;
- a custom writer object outside the Effect-native Durable Streams producer;
- a callback bridge in runtime code;
- `@durable-streams/*` imports outside the Effect-native Durable Streams package;
- legacy `@firegrid/durable-streams/log` or `/producer` helpers in the new path.

If it fails, the next step is to revise PR #148's API before more workflow,
tools, ingress subscriber, or required-action tracers build on it.

## Relationship To Tracer 014

Tracer 014 is the substrate stabilization line. This tracer is the Firegrid
runtime proof for that line.

The 014 spec says the durable-streams surface must support stream observation,
scoped writing, and removal of bespoke ingress/output event-store wrappers. This
tracer narrows that into one executable proof without requiring a full migration
of the existing runtime host.

## Implementation Handoff

Use PR #148 as the source for the Effect-native Durable Streams API. Do not
invent new interfaces.

Expected imports in the new path should look closer to:

```ts
import { FetchHttpClient } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { DurableStream } from "effect-durable-streams"
```

and should not look like:

```ts
import { appendJson, readRetainedJson } from "@firegrid/durable-streams/log"
import { openDurableStreamProducer } from "@firegrid/durable-streams/producer"
```

The coding agent should implement this in an isolated worktree against the PR
#148 branch if #148 is not on `main` yet. If the API has moved during benchmark
work, update this tracer doc to match the accepted API before implementing.
