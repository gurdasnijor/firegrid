# 002: Runtime Events To Session State

Date: 2026-05-09

Status: implemented; aligned to the Event Pipeline architecture.

## Goal

Prove the narrow path from:

```txt
runtime-output Durable Streams journal
```

to:

```txt
session-shaped State Protocol stream
```

Runtime-output rows remain the durable source of truth. Session state is a
derived projection.

## Architecture

This tracer uses the canonical materialization path:

```txt
RuntimeOutputEventSourceLive
  -> RuntimeOutputSessionProjectorLive
  -> StateProtocolEventSinkLive
  -> EventPipelineLive
```

The ergonomic helper is a named EventPipeline composition:

```ts
const summary = yield* runSessionProjection({
  runtimeOutputStreamUrl,
  sessionStateStreamUrl,
  contextId,
})
```

It returns `EventPipelineSummary`. There is no materializer-runner wrapper and
no alternate summary type.

## Source

`RuntimeOutputEventSourceLive` reads retained `RuntimeJournalEvent` rows from
the runtime-output data-plane stream, filters by `contextId`, applies the
caller-owned `(activityAttempt, sequence)` cursor when supplied, and returns
source events plus decode failures.

## Projector

`RuntimeOutputSessionProjectorLive` is the provider/user interpretation layer.
The first projector is intentionally tiny: it recognizes stdout JSONL payloads
of the form:

```json
{ "type": "assistant", "text": "pong" }
```

and projects them into `SessionStateChange` values. Unknown payloads are
ignored. Malformed JSON is reported as a projector failure.

Projector results are tagged:

```ts
type EventProjectorResult<Event> =
  | { readonly _tag: "Projected"; readonly events: ReadonlyArray<Event> }
  | { readonly _tag: "Ignored"; readonly reason?: string }
  | { readonly _tag: "Failed"; readonly failures: ReadonlyArray<EventPipelineFailure> }
```

## Sink

`StateProtocolEventSinkLive` accepts `SessionStateChange` events and writes
State Protocol upserts through `StateProtocolWriterLive`. The writer uses
deterministic txids based on projector identity, version, and projected primary
key, so retained re-runs converge on the same materialized state.

## Acceptance

The scenario proves:

1. Provider-owned fields inside the stdout payload do not collide with
   projection fields.
2. Malformed provider payloads fail at the projector boundary without writing
   session rows.
3. Malformed runtime journal envelopes are isolated as source failures.
4. Cursor filtering applies before projection.
5. Re-running `runSessionProjection(...)` is idempotent at the observed session
   state layer.
