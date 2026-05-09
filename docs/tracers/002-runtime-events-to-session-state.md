# 002: Runtime Output Events To Session State

Date: 2026-05-08

Status: planned; next tracer after the runtime control/data-plane split.

Substrate: this tracer starts from raw runtime output data-plane events produced
by tracer 001 and emits Durable Streams State Protocol change messages to a
separate session-state topic. Durable State is used at the projection output
boundary, not as the source journal format.

Spec anchors:

- `durable-records-and-projections.RECORDS.3`
- `durable-records-and-projections.RECORDS.4`
- `durable-records-and-projections.RECORDS.5`
- `durable-records-and-projections.PROJECTIONS.1`
- `durable-records-and-projections.PROJECTIONS.2`
- `durable-records-and-projections.PROJECTIONS.3`
- `durable-records-and-projections.PROJECTIONS.6`
- `durable-records-and-projections.REBUILD.1`
- `durable-records-and-projections.REBUILD.2`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.1`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.6`
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2`
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.3`

## Goal

Prove the smallest production-shaped materialization path from:

```txt
raw runtime output data-plane events
```

to:

```txt
session-shaped State Protocol resources
```

This tracer proves that session materialization is a replayable downstream
consumer. It is not a synchronous responsibility of `launch(...)`,
`startRuntime(...)`, the runtime context workflow, or the sandbox provider.

Unlike tracer 001, reusable materializer code should land in packages. The
scenario test should only be the end-to-end acceptance harness.

## Current Baseline

The merged runtime architecture now has hard control/data-plane boundaries:

```txt
packages/runtime/src/control-plane/runtime-context/
  service.ts      // RuntimeControlPlane: contexts and runs via StreamDB
  workflow.ts     // @effect/workflow runtime execution coordinator
  launcher.ts     // startRuntime(...) host-facing entrypoint

packages/runtime/src/data-plane/runtime-output/
  writer.ts       // RuntimeCaptureJournal: raw runtime output journal writer

packages/protocol/src/launch/
  state.ts        // runtimeContextStateSchema: contexts and runs only
  schema.ts       // RuntimeJournalEventSchema: stdout/stderr journal facts
```

The important rule for tracer 002:

```txt
source = raw RuntimeJournalEventSchema data-plane events
target = session State Protocol change messages
```

Do not consume producer-side State Protocol collections for stdout/stderr. That
was the old failure mode. The source journal is made of schema-decoded runtime
output facts such as `firegrid.runtime.output.stdout`.

## Topic Roles

Use role names in scenarios, not a heavyweight topology abstraction:

```txt
runtime-control   // State Protocol contexts and run rows
runtime-output    // raw data-plane RuntimeJournalEvent rows
workflow-state    // internal @effect/workflow execution/activity/claim rows
firegrid-session  // tracer 002 State Protocol session projection rows
```

`runtime-output` is the source for this tracer. `firegrid-session` is the derived
State Protocol topic. `runtime-control` may be used only to discover or verify
the runtime context; it is not the source of session messages.

The materializer may run in a runtime host, app worker, test scenario, or future
subscriber. It must not require the original child process, stdout pipe, sandbox
object, provider SDK client, or workflow internals.

## Production Shape

Tracer 002 should add package-level code rather than placing the materializer
inside `scenarios/`.

Suggested package placement:

```txt
packages/protocol/src/session/
  schema.ts       // minimal session/message projection schemas
  state.ts        // createStateSchema(...) for the session topic
  index.ts

packages/runtime/src/data-plane/materialization/
  runner.ts                 // retained raw-journal to State Protocol runner
  producer.ts               // StateProtocolProducer backed by IdempotentProducer
  example-jsonl-session.ts  // first concrete tiny materializer
  registry.ts               // static built-in materializer map
  index.ts
```

The placement matters:

- source readers and materializer runners are data-plane consumers;
- session schemas are protocol-level projection schemas;
- control-plane runtime context modules must not grow session materialization
  responsibilities.

The scenario should import package APIs and prove the path:

```txt
@firegrid/client
  -> @firegrid/runtime startRuntime(...)
  -> runtime-output raw journal rows
  -> @firegrid/runtime/data-plane/materialization
  -> @firegrid/protocol/session
  -> fresh StreamDB client observes session rows
```

It should not define its own session state schema, materializer runner, or
row-writing helpers except for narrow test setup.

## Starting Point

Tracer 001 has already produced retained runtime output events. The original
agent process may still be running, already exited, or unavailable.

The source row shape is the protocol journal envelope from
`packages/protocol/src/launch/schema.ts`:

```ts
{
  type: "firegrid.runtime.output.stdout",
  id: "event_ctx_123_1_0",
  at: "2026-05-08T00:00:00.000Z",
  event: {
    eventId: "event_ctx_123_1_0",
    contextId: "ctx_123",
    activityAttempt: 1,
    sequence: 0,
    source: "stdout",
    format: "jsonl",
    receivedAt: "2026-05-08T00:00:00.000Z",
    raw: "{\"type\":\"assistant\",\"text\":\"pong\"}",
  },
}
```

The first materializer only understands that example JSONL payload. Unknown,
unsupported, or malformed payloads are not deleted or rewritten; they remain
durable runtime output events for later materializers.

For tracer 002, `(activityAttempt, sequence)` is the documented runtime output
cursor and ordering key. Durable Streams position is a transport/read detail for
this tracer, not the materializer cursor. Tracer 001 must write output rows so
stream order and `(activityAttempt, sequence)` order agree for one context.
Wall-clock timestamps are data, not ordering authority.

## End Point

The materializer emits State Protocol change messages to `firegrid-session`.

Minimal session projection:

```ts
type ContextId = string & { readonly _tag: "ContextId" }

type SessionProjection = {
  readonly sessionId: string
  readonly contextId: ContextId
  readonly status: "active" | "completed" | "failed"
}

type MessageProjection = {
  readonly messageId: string
  readonly sessionId: string
  readonly contextId: ContextId
  readonly role: "assistant" | "user" | "system" | "tool"
  readonly text: string
  readonly sourceRuntimeEventId: string
  readonly createdAt: string
}

const sessionStateSchema = createStateSchema({
  sessions: {
    type: "firegrid.session",
    primaryKey: "sessionId",
    schema: Schema.standardSchemaV1(SessionProjectionSchema),
  },
  messages: {
    type: "firegrid.session.message",
    primaryKey: "messageId",
    schema: Schema.standardSchemaV1(MessageProjectionSchema),
  },
})
```

Example State Protocol output:

```ts
sessionStateSchema.messages.upsert({
  value: {
    messageId: "msg_ctx_123_1_0",
    sessionId: "session_ctx_123",
    contextId: "ctx_123",
    role: "assistant",
    text: "pong",
    sourceRuntimeEventId: "event_ctx_123_1_0",
    createdAt: "2026-05-08T00:00:00.000Z",
  },
})
```

The session row is a projection. Its authority is the source runtime output
event plus the materializer version that interpreted it.

## Materializer Contract

The reusable runner should accept a pure materializer. The materializer owns
provider-specific parsing and returns plain projection changes. The runner owns
source ordering, cursor filtering, conversion into State Protocol events,
producer identity, and durable writes.

```ts
type RuntimeOutputCursor = {
  readonly activityAttempt: number
  readonly sequence: number
}

type MaterializerFailure = {
  readonly sourceRuntimeEventId: string
  readonly reason: string
  readonly cause?: unknown
}

type MaterializerChange =
  | {
      readonly kind: "upsertSession"
      readonly value: SessionProjection
    }
  | {
      readonly kind: "upsertMessage"
      readonly value: MessageProjection
    }

type MaterializerProjectResult = {
  readonly changes: ReadonlyArray<MaterializerChange>
  readonly failures: ReadonlyArray<MaterializerFailure>
}

type RuntimeOutputMaterializer = {
  readonly name: string
  readonly version: string
  readonly project: (
    row: RuntimeEvent,
  ) => MaterializerProjectResult
}
```

V0 projections are upsert-only. Delete/retraction semantics are deliberately
out of scope until a later tracer proves a provider or product workflow needs
them.

The first concrete materializer can stay intentionally tiny:

```ts
type DecodeOutcome =
  | { readonly _tag: "ok"; readonly event: { readonly type: "assistant"; readonly text: string } }
  | { readonly _tag: "skip" }
  | { readonly _tag: "fail"; readonly failure: MaterializerFailure }

export const exampleJsonlSessionMaterializer: RuntimeOutputMaterializer = {
  name: "example-jsonl-session",
  version: "0",
  project: (row) => {
    const outcome: DecodeOutcome = decodeExampleAssistantEvent(row)
    switch (outcome._tag) {
      case "skip":
        return { changes: [], failures: [] }
      case "fail":
        return { changes: [], failures: [outcome.failure] }
      case "ok":
        break
    }

    return {
      failures: [],
      changes: [
        {
          kind: "upsertSession",
          value: {
            sessionId: `session_${row.contextId}`,
            contextId: row.contextId,
            status: "active",
          },
        },
        {
          kind: "upsertMessage",
          value: {
            messageId: `msg_${row.contextId}_${row.activityAttempt}_${row.sequence}`,
            sessionId: `session_${row.contextId}`,
            contextId: row.contextId,
            role: "assistant",
            text: outcome.event.text,
            sourceRuntimeEventId: row.eventId,
            createdAt: row.receivedAt,
          },
        },
      ],
    }
  },
}
```

The function may parse the provider/example payload because it is the
provider/example materializer. The runtime context workflow still must not parse
provider message semantics.

Parsing failures in this tracer should produce no session rows and should be
observable in the materializer result. They should not mutate or delete the
source runtime output event.

The initial built-in registry can be static:

```ts
export const builtinMaterializers = {
  "example-jsonl-session": exampleJsonlSessionMaterializer,
} as const
```

This is not a dynamic plugin registry. It is only the package-local extension
point that keeps tracer 003 from inventing a second materializer selection
pattern.

## Target Producer

The write side should use Durable Streams `IdempotentProducer`, not StreamDB
actions. A materializer is a server-side projection job, not a UI-style
optimistic mutation. It should batch, flush, and deduplicate at the Durable
Streams producer protocol layer.

Wrap that in a small Effect service so the runner is testable:

```ts
class StateProtocolProducer extends Context.Tag("firegrid/StateProtocolProducer")<
  StateProtocolProducer,
  {
    readonly open: (options: {
      readonly streamUrl: string
      readonly producerId: string
    }) => Effect.Effect<
      {
        readonly append: (event: unknown) => Effect.Effect<void, ProducerError>
        readonly flush: Effect.Effect<void, ProducerError>
      },
      ProducerError,
      Scope
    >
  }
>() {}
```

The live layer uses a stable producer id:

```ts
const producerIdFor = (
  materializer: RuntimeOutputMaterializer,
  contextId: string,
) => `session-materializer:${materializer.name}:${materializer.version}:${contextId}`
```

`IdempotentProducer` protects against duplicate transport sends for the same
producer identity. Deterministic projected primary keys protect the logical
session state if the whole materializer is re-run over retained source rows.
`producer.append(...)` should enqueue into the producer buffer; `producer.flush`
is the durable round trip that must complete before the runner returns.

`toSessionStateEvent(change)` should use deterministic txids derived from the
projected primary key and materializer version:

```ts
const toSessionStateEvent = (
  change: MaterializerChange,
  materializer: RuntimeOutputMaterializer,
) => {
  switch (change.kind) {
    case "upsertSession":
      return sessionStateSchema.sessions.upsert({
        value: change.value,
        headers: {
          txid: `${materializer.name}:${materializer.version}:session:${change.value.sessionId}`,
        },
      })
    case "upsertMessage":
      return sessionStateSchema.messages.upsert({
        value: change.value,
        headers: {
          txid: `${materializer.name}:${materializer.version}:message:${change.value.messageId}`,
        },
      })
  }
}
```

That policy gives the projection two idempotency layers: stable producer identity
for duplicate transport sends, and stable State Protocol txids/primary keys for
full retained re-runs.

If a materializer run fails after some changes were appended, partial progress
is acceptable. A later run with the same source rows, materializer identity, and
context id must converge to the same materialized session state.

## Runner Shape

The runner should be production code. It reads raw runtime output journal events
from the data-plane stream and writes State Protocol changes to the session
projection stream.

It remains retained-replay only for this tracer, but the input should include a
`since` cursor so later live/cursor tracers do not have to change the API.

```ts
type MaterializerSummary = {
  readonly rowsRead: number
  readonly rowsProjected: number
  readonly rowsIgnored: number
  readonly rowsEmpty: number
  readonly rowsFailed: number
  readonly changesEmitted: number
  readonly failures: ReadonlyArray<MaterializerFailure>
}

type MaterializeRuntimeOutputToSessionOptions = {
  readonly sourceDataPlaneStreamUrl: string
  readonly targetSessionStreamUrl: string
  readonly contextId: ContextId
  readonly materializer: RuntimeOutputMaterializer
  readonly since?: RuntimeOutputCursor
}

const materializeRuntimeOutputToSession = (
  options: MaterializeRuntimeOutputToSessionOptions,
) =>
  Effect.scoped(Effect.gen(function* () {
    const journal = yield* readRuntimeJournal({
      streamUrl: options.sourceDataPlaneStreamUrl,
      contextId: options.contextId,
    })

    const rows = journal.events
      .flatMap((event) =>
        event.type === "firegrid.runtime.output.stdout" ? [event.event] : []
      )
      .filter((row) => row.contextId === options.contextId)
      .filter((row) => isAfterRuntimeOutputCursor(row, options.since))
      .sort(compareRuntimeOutputOrder)

    const producerFactory = yield* StateProtocolProducer
    const producer = yield* producerFactory.open({
      streamUrl: options.targetSessionStreamUrl,
      producerId: producerIdFor(options.materializer, options.contextId),
    })

    const summary = yield* Effect.reduce(rows, {
      rowsRead: rows.length + journal.decodeFailures.length,
      rowsProjected: 0,
      rowsIgnored: 0,
      rowsEmpty: 0,
      rowsFailed: journal.decodeFailures.length,
      changesEmitted: 0,
      failures: journal.decodeFailures,
    } satisfies MaterializerSummary, (acc, row) => {
      const result = options.materializer.project(row)
      if (result.failures.length > 0) {
        return Effect.succeed({
          ...acc,
          rowsFailed: acc.rowsFailed + 1,
          failures: [...acc.failures, ...result.failures],
        })
      }

      const changes = result.changes
      if (changes.length === 0) {
        return Effect.succeed({
          ...acc,
          rowsIgnored: acc.rowsIgnored + 1,
        })
      }

      return Effect.forEach(changes, change =>
        producer.append(toSessionStateEvent(change, options.materializer)),
      { discard: true }).pipe(
        Effect.as({
          ...acc,
          rowsProjected: acc.rowsProjected + 1,
          changesEmitted: acc.changesEmitted + changes.length,
        }),
      )
    })

    yield* producer.flush

    return summary
  }))
```

`readRuntimeJournal(...)` should read and decode `RuntimeJournalEventSchema`
from Durable Streams. It should not open a StreamDB source collection for
runtime stdout/stderr. A fresh StreamDB client is appropriate for verifying the
target `firegrid-session` projection.

For tracer 002, `readRuntimeJournal(...)` may read the retained runtime-output
stream and filter by `contextId` client-side. It should tolerate malformed
journal envelopes by returning decode failures alongside decoded events, rather
than aborting the whole run. That is acceptable for the first single-context
tracer. Later live or multi-context tracers should introduce partitioning,
server-side filtering, streaming decode, or checkpointed subscriber reads
instead of requiring every materializer run to load the full retained stream.

Cursor management is caller-owned in this tracer. `since` is an input to the
stateless runner; later tracers may layer a checkpoint workflow or subscriber on
top without changing the pure materializer contract.

This runner is not the final subscriber architecture. It is the production
retained-replay primitive that a later live subscriber can reuse or wrap.

## Cursor Utilities

Cursor semantics should live in protocol-level utilities so tracer 003 and later
consumers cannot drift:

```ts
export const compareRuntimeOutputOrder = (
  left: RuntimeEvent,
  right: RuntimeEvent,
): number =>
  left.activityAttempt - right.activityAttempt ||
  left.sequence - right.sequence

export const isAfterRuntimeOutputCursor = (
  row: RuntimeEvent,
  since: RuntimeOutputCursor | undefined,
): boolean =>
  since === undefined ||
  row.activityAttempt > since.activityAttempt ||
  (
    row.activityAttempt === since.activityAttempt &&
    row.sequence > since.sequence
  )
```

The runner should depend only on Durable Streams client APIs and
`@firegrid/protocol` schemas/utilities. It must not import runtime workflow
internals, control-plane runtime context modules, sandbox providers, or
provider SDKs.

## Minimum Path

1. Run tracer 001 to append a runtime context and produce retained
   `RuntimeJournalEventSchema` rows in the data-plane stream.
2. Stop relying on the live process; only retained stream data remains.
3. Read retained stdout runtime output events from the data-plane stream for the
   runtime context id.
4. Decode only the provider wire format owned by the selected materializer.
5. Convert materializer changes into State Protocol messages.
6. Emit those messages to `firegrid-session` through `StateProtocolProducer`,
   backed by `IdempotentProducer` with a stable materializer producer id.
7. Open a fresh State Protocol client on `firegrid-session` and verify it
   materializes the same session-shaped resources without access to the original
   process.

The acceptance path should chain 001 into 002:

```txt
firegrid.launch(...)
  -> startRuntime(...)
  -> retained runtime-output events exist
  -> materializeRuntimeOutputToSession(..., exampleJsonlSessionMaterializer)
  -> fresh session StreamDB observes projected message row
```

## Non-Goals

- ACP-wide projection coverage.
- Claude Code schema coverage beyond the single tracer event shape.
- Flamecast session model compatibility.
- Permission request detection.
- Durable stdin delivery back to the agent.
- Live tailing while the process is still active.
- A dynamic plugin materializer registry.
- A public Firegrid session API.
- Scenario-local materializer implementations.
- Materializer run-health topics.

## Acceptance Sketch

The tracer is complete when one automated scenario proves:

1. `firegrid.launch(...)` and `startRuntime(...)` produce retained raw runtime
   output data-plane events.
2. The launched process has exited before materialization begins.
3. The materializer reads `RuntimeJournalEventSchema` rows from the data-plane
   stream and writes State Protocol changes to a separate session topic through
   a stable `IdempotentProducer`.
4. The runner returns a summary with `rowsProjected: 1`,
   `changesEmitted: 2`, and no failures for the happy path.
5. Re-running `materializeRuntimeOutputToSession(...)` with the same input
   produces the same materialized session state. The session topic may contain
   repeated compatible change messages; the materialized collections observe no
   duplicate logical rows because primary keys and txids are deterministic.
6. A fresh StreamDB client opens the session topic and observes an assistant
   message row with:
   - `contextId` matching the original context;
   - `text` derived from the runtime output JSONL payload;
   - `sourceRuntimeEventId` pointing back to the durable runtime output event.
7. The materializer does not import runtime workflow internals or use live
   process handles, stdout pipes, provider SDK clients, or sandbox objects.
8. The scenario imports the materializer runner and session schema from package
   exports rather than defining them locally.

## Follow-On Questions

- Should a later tracer introduce live tailing and cursor checkpoints, or is
  retained replay enough for the first MVP session materializer?
- Should product packages own richer session-state schemas, with Firegrid
  exposing only the minimal projection primitives and reference materializers?
- Which provider should be the first real non-example materializer: Claude Code
  stream JSON or ACP?
- Should materializer run summaries eventually be written to a separate
  `firegrid.materializer.runs` topic? Tracer 002 returns a typed summary only
  and keeps the projection topic clean.
- Future materializers may need cross-row state or contextual configuration.
  When that lands, choose an explicit state/context contract; do not introduce
  module-global materializer state.

## Invariants

1. **Journal authority.** Every materialized session fact is derivable from
   retained raw runtime output events.
2. **Replay equivalence.** Running the materializer after the process exits
   produces the same session-state stream as running it while the process is
   active.
3. **Consumer independence.** The materializer does not need runtime context
   workflow internals, process handles, stdin/stdout pipes, sandbox objects, or
   provider SDK clients.
4. **Projection idempotency.** Replaying the same runtime output event with the
   same materializer version produces the same change values, writes through a
   stable materializer producer id, and upserts the same logical session row
   ids. Duplicate producer sends are handled at the Durable Streams producer
   layer; full materializer re-runs remain safe because projected state rows use
   deterministic primary keys. Partial materializer runs are also safe to rerun
   because already flushed changes use deterministic txids and primary keys.
5. **State Protocol boundary.** The source data-plane stream is raw runtime
   journal facts. The target session stream is State Protocol. The materializer
   is the only component in this tracer that crosses that boundary.
