# 002: Runtime Events To Session State

Date: 2026-05-08

Status: planned

Substrate: this tracer starts from the runtime event rows produced by tracer
001 and emits Durable Streams State Protocol change messages to a separate
session-state topic.

Spec anchors:

- `durable-records-and-projections.RECORDS.3`
- `durable-records-and-projections.RECORDS.4`
- `durable-records-and-projections.RECORDS.5`
- `durable-records-and-projections.PROJECTIONS.1`
- `durable-records-and-projections.PROJECTIONS.2`
- `durable-records-and-projections.PROJECTIONS.3`
- `durable-records-and-projections.PROJECTIONS.6`
- `durable-records-and-projections.REBUILD.1`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5`
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.6`

## Goal

Prove the smallest production-shaped materialization path from:

```txt
durable runtime event rows
```

to:

```txt
session-shaped State Protocol resources
```

This tracer proves that session materialization is a replayable downstream
consumer, not a synchronous responsibility of agent launch. Unlike tracer 001,
the reusable code should land in packages, with the scenario test acting only as
the end-to-end acceptance harness.

The production primitive is generic: read retained runtime event rows, apply a
materializer, and write State Protocol changes to a target topic. The first
concrete materializer can stay intentionally small, but it should still use the
same package API future materializers will use.

## Topic Roles

Use named topic roles in the scenario, not a heavyweight topology abstraction:

```txt
firegrid.runtime       // runtime contexts, run rows, runtime event rows, runtime log rows
firegrid.workflow     // internal @effect/workflow execution/activity/claim rows
agent.session         // tracer 002 session projection rows
```

`firegrid.runtime` is the source topic for runtime event rows. `agent.session`
is the derived State Protocol topic for the first minimal session projection.

The materializer may be run by a runtime host, app process, test scenario, or
future subscriber. It is not part of the runtime context workflow and does not require
access to the original child process.

## Production Shape

Tracer 002 should add package-level code rather than placing the materializer
inside `scenarios/`.

Suggested package placement:

```txt
packages/protocol/src/session/
  schema.ts      // minimal session/message projection schemas
  state.ts       // createStateSchema(...) for the session topic
  index.ts

packages/runtime/src/materializers/
  runtime-events.ts             // generic retained runtime event materializer runner
  producer.ts                   // StateProducer service backed by IdempotentProducer
  example-jsonl-session.ts      // first concrete tiny materializer
  registry.ts                   // static built-in materializer map
  index.ts
```

The scenario should import these package APIs and prove the public path:

```txt
@firegrid/client
  -> @firegrid/runtime
  -> @firegrid/runtime/materializers
  -> @firegrid/protocol/session
```

It should not define its own state schema, materializer runner, or row-writing
helpers except for test setup.

## Starting Point

Tracer 001 has already journaled provider output as durable runtime event rows.
The original agent process may still be running, already exited, or unavailable.

The materializer opens `firegrid.runtime`, materializes the retained runtime context state,
and reads runtime event rows for one context id in durable row order. Durable row
order comes from stream position or the documented per-attempt sequence, not
from wall-clock timestamps.

Use the smallest runtime event shape needed to prove the boundary:

```ts
{
  contextId: "ctx_123",
  eventId: "runtime event-ctx_123-1-0",
  activityAttempt: 1,
  sequence: 0,
  source: "stdout",
  format: "jsonl",
  receivedAt: "2026-05-08T00:00:00.000Z",
  raw: "{\"type\":\"assistant\",\"text\":\"pong\"}",
}
```

The first materializer only understands that example JSONL shape. Unknown or
unsupported runtime event rows are ignored by the first session projection, but
they remain durable runtime event rows for later materializers.

## End Point

The materializer emits State Protocol change messages (`insert`, `update`,
`delete`) to the separate `agent.session` topic.

Minimal production session projection:

```ts
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
    sourceRuntimeEventId: "runtime event-ctx_123-1-0",
    createdAt: "2026-05-08T00:00:00.000Z",
  },
})
```

The output row carries provenance back to the source runtime event row. The
session row is a projection, not authority independent of the runtime event
journal.

## Materializer Contract

The reusable runner should accept a pure materializer. The materializer owns
provider-specific parsing and returns plain change data. The runner owns
retained-row ordering, conversion into State Protocol events, producer identity,
and durable writes.

```ts
type RuntimeEventCursor = {
  readonly activityAttempt: number
  readonly sequence: number
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

type RuntimeEventMaterializer = {
  readonly name: string
  readonly version: string
  readonly project: (row: RuntimeEvent) => ReadonlyArray<MaterializerChange>
}
```

The first concrete materializer should live in package code and can remain tiny:

```ts
export const exampleJsonlSessionMaterializer: RuntimeEventMaterializer = {
  name: "example-jsonl-session",
  version: "0",
  project: (row) => {
    const event = decodeExampleAssistantEvent(row.raw)
    if (event === undefined) return []

    return [
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
          text: event.text,
          sourceRuntimeEventId: row.eventId,
          createdAt: row.receivedAt,
        },
      },
    ]
  },
}
```

The function may parse the provider-specific payload because it is the
provider/example materializer. The runtime context workflow still must not parse provider
message semantics.

Parsing failures in this tracer should produce no session rows and should be
observable in the materializer result. They should not mutate or delete the
source runtime event row.

The initial built-in registry can be static:

```ts
export const builtinMaterializers = {
  "example-jsonl-session": exampleJsonlSessionMaterializer,
} as const
```

This is not a dynamic plugin registry. It is just the package-local extension
point that keeps tracer 003 from inventing a second materializer selection
pattern.

## Target Producer

The write side should use Durable Streams `IdempotentProducer`, not StreamDB
actions. StreamDB remains the correct source-read and verification shape. A
materializer is closer to a server-side projection job than a UI-style
optimistic mutation, so the target writer should batch, flush, and handle
producer retry/deduplication at the Durable Streams producer protocol layer.

Wrap that in a small Effect service so the runner is testable:

```ts
class StateProducer extends Context.Tag("firegrid/StateProducer")<
  StateProducer,
  {
    readonly append: (event: unknown) => Effect.Effect<void, ProducerError>
    readonly flush: Effect.Effect<void, ProducerError>
  }
>() {}
```

The live layer uses a stable producer id:

```ts
const producerIdFor = (
  materializer: RuntimeEventMaterializer,
  contextId: string,
) => `materializer:${materializer.name}:${materializer.version}:${contextId}`

const StateProducerLive = (options: {
  readonly streamUrl: string
  readonly producerId: string
  readonly createIfMissing?: boolean
  readonly lingerMs?: number
}) =>
  Layer.scoped(StateProducer, Effect.gen(function* () {
    const stream = new DurableStream({ url: options.streamUrl })
    if (options.createIfMissing === true) {
      yield* ensureJsonStreamExists(stream, options.streamUrl)
    }

    const producer = new IdempotentProducer(stream, options.producerId, {
      autoClaim: true,
      lingerMs: options.lingerMs ?? 10,
    })

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await producer.flush()
        await producer.close()
      }),
    )

    return StateProducer.of({
      append: (event) => Effect.sync(() => {
        producer.append(JSON.stringify(event))
      }),
      flush: Effect.promise(() => producer.flush()),
    })
  }))
```

`ensureJsonStreamExists(...)` should follow the Durable Streams head-or-create
pattern: call `head()` and create the stream with `application/json` only when
the target topic is missing. Tests may still pre-create topics, but production
code should be able to create the first session topic for a launch.

## Runner Shape

The runner should be production code. It should use StreamDB on the read side
and `StateProducer` on the write side. It remains retained-replay only for this
tracer, but the input should include a `since` cursor so later live/cursor
tracers do not have to change the API.

```ts
type MaterializerSummary = {
  readonly rowsRead: number
  readonly rowsProjected: number
  readonly rowsSkipped: number
  readonly rowsFailed: number
  readonly changesEmitted: number
  readonly failures: ReadonlyArray<MaterializerFailure>
}

const materializeRuntimeEvents = ({
  sourceTopicUrl,
  targetTopicUrl,
  contextId,
  materializer,
  since,
}: {
  sourceTopicUrl: string
  targetTopicUrl: string
  contextId: string
  materializer: RuntimeEventMaterializer
  since?: RuntimeEventCursor
}) =>
  Effect.scoped(Effect.gen(function* () {
    const runtimeJournal = yield* readRuntimeJournal({
      streamUrl: sourceTopicUrl,
    })
    const producer = yield* StateProducer

    const rows = runtimeJournal
      .flatMap((event) =>
        event.type === "firegrid.runtime.output.stdout" ? [event.event] : []
      )
      .filter((row) => row.contextId === contextId)
      .filter((row) => isAfterRuntimeEventCursor(row, since))
      .sort(compareRuntimeEventOrder)

    let changesEmitted = 0
    let rowsProjected = 0
    let rowsSkipped = 0
    const failures: Array<MaterializerFailure> = []

    for (const row of rows) {
      const changes = materializer.project(row)
      if (changes.length === 0) {
        rowsSkipped += 1
        continue
      }

      rowsProjected += 1
      for (const change of changes) {
        yield* producer.append(toSessionStateEvent(change))
        changesEmitted += 1
      }
    }

    yield* producer.flush

    return {
      rowsRead: rows.length,
      rowsProjected,
      rowsSkipped,
      rowsFailed: failures.length,
      changesEmitted,
      failures,
    }
  }))
```

This runner is not the final subscriber architecture. It is the production
retained-replay primitive that a later live subscriber can reuse or wrap.

## Minimum Path

1. Run tracer 001 to produce retained runtime event rows for a real launch.
2. Stop using the live process; only the durable runtime context topic remains.
3. Read retained runtime event rows from `firegrid.runtime` for the context id.
4. Decode only the provider wire format owned by the selected materializer.
5. Convert materializer changes into State Protocol messages.
6. Emit those messages to `agent.session` through `StateProducerLive`, backed by
   `IdempotentProducer` with a stable materializer producer id.
7. Open a fresh State Protocol client on `agent.session` and verify it
   materializes the same session-shaped resources without access to the original
   process.

The acceptance path should chain 001 into 002:

```txt
client.launch(...)
  -> startRuntime(...)
  -> retained runtime event rows exist
  -> materializeRuntimeEvents(..., exampleJsonlSessionMaterializer)
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

1. `firegrid.launch(...)` and `startRuntime(...)` produce retained
   runtime event rows.
2. The launched process has exited before materialization begins.
3. The materializer reads runtime event rows from the runtime context topic and writes
   State Protocol changes to a separate session topic through a stable
   `IdempotentProducer`.
4. The runner returns a summary with `rowsProjected: 1`,
   `changesEmitted: 2`, and no failures for the happy path.
5. Re-running the materializer with the same materializer name, version, and
   context id is safe: the producer layer handles duplicate transport attempts,
   and deterministic projection ids prevent duplicate logical session rows.
6. A fresh StreamDB client opens the session topic and observes an assistant
   message row with:
   - `contextId` matching the original context;
   - `text` derived from the runtime event JSONL payload;
   - `sourceRuntimeEventId` pointing back to the durable runtime event row.
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

## Invariants

1. **Journal authority.** Every materialized session fact is derivable from
   retained runtime event rows.
2. **Replay equivalence.** Running the materializer after the process exits
   produces the same session-state stream as running it while the process is
   active.
3. **Consumer independence.** The materializer does not need runtime context workflow
   internals, process handles, stdin/stdout pipes, or provider SDK clients.
4. **Projection idempotency.** Replaying the same runtime event row with the
   same materializer version produces the same change values, writes through a
   stable materializer producer id, and upserts the same logical session row ids.
   Duplicate producer sends are handled at the Durable Streams producer layer;
   full materializer re-runs remain safe because projected state rows use
   deterministic primary keys.
