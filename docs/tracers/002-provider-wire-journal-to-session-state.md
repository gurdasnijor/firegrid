# 002: Provider-Wire Journal To Session State

Date: 2026-05-08

Status: planned

Substrate: this tracer starts from the provider-wire journal produced by tracer
001 and emits Durable Streams State Protocol change messages to a separate
session-state stream.

## Goal

Prove the smallest downstream materialization path from:

```txt
durable provider-wire journal
```

to:

```txt
session-shaped State Protocol resources
```

This tracer proves that session materialization is a replayable downstream
consumer, not a synchronous responsibility of agent launch.

## Starting Point

Tracer 001 has already journaled provider output as durable provider-wire rows.
The original agent process may still be running, already exited, or unavailable.

The materializer opens the provider-wire stream and reads retained rows from a
durable offset.

## End Point

The materializer emits State Protocol change messages (`insert`, `update`,
`delete`) to a separate session-state stream.

Example resource families:

```ts
const SessionState = {
  sessions: Collection<SessionResource>,
  messages: Collection<MessageResource>,
  activities: Collection<ActivityResource>,
}
```

Example State Protocol output:

```ts
sessionStateSchema.messages.upsert({
  value: {
    id: "msg_123",
    launchId: "launch_123",
    role: "assistant",
    text: "pong",
    createdAt: "2026-05-08T00:00:00.000Z",
  },
})
```

## Minimum Path

1. Read retained provider-wire rows produced by tracer 001.
2. Decode only the provider wire format owned by the selected materializer.
3. Emit State Protocol changes to the session-state stream.
4. Open a fresh State Protocol client and verify it materializes the same
   session-shaped resources without access to the original process.

## Invariants

1. **Journal authority.** Every materialized session fact is derivable from
   retained provider-wire rows.
2. **Replay equivalence.** Running the materializer after the process exits
   produces the same session-state stream as running it while the process is
   active.
3. **Consumer independence.** The materializer does not need launch workflow
   internals, process handles, stdin/stdout pipes, or provider SDK clients.
