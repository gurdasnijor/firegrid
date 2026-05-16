# Runtime Pipeline Composition

`pipeline/` is per-session event-loop composition. It is not a durable stage.
The reconciliation target is to inline this role as
`agent-event-pipeline/session-runtime.ts` after host extraction.

## Pipeline Fit

This folder wires the stage roles together for a running codec session:

```txt
sources -> codecs -> transforms -> authorities
                         |
                         v
                    subscribers
```

It may open sessions, fork scoped subscribers, run row streams through durable
sinks, and return terminal evidence. It should not define new domain concepts
that belong in `events/`, `codecs/`, `authorities/`, or `subscribers/`.

Composition shape:

```ts
Effect.scoped(Effect.gen(function* () {
  const sessionLayer = selectSessionLayer(bytes, context.runtime.config.agentProtocol)

  yield* Effect.gen(function* () {
    const session = yield* AgentSession

    yield* Subscribers.ingressDelivery({ send: session.send }).pipe(Effect.forkScoped)
    yield* Subscribers.toolRouter({
      context,
      activityAttempt,
      toolUseMode: session.toolUseMode,
    }).pipe(Effect.forkScoped)

    const outputSink = yield* RuntimeAgentOutputRowSink
    yield* Stream.run(outputRows(session.outputs), outputSink)
  }).pipe(Effect.provide(sessionLayer))
}))
```

`firegrid-runtime-boundary-reconciliation.CODEC_SESSION.1` and
`firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2` mean the pipeline
selects a concrete scoped session `Layer` from the runtime protocol and then
consumes the active `AgentSession` service from the Effect requirement channel.
It should not accept or retain a codec object with an `open(...)` method.

The pipeline wires live capabilities together. It should not make static
decisions that belong to codec sessions, and it should not write durable rows
except through authority tags.

## Boundary Rules

- Compose capability tags through Effect requirements and layers.
- Do not hide unresolved layer requirements behind `as Layer<...>` casts.
- Do not construct raw durable rows ad hoc when an event/envelope helper exists.
- Keep this folder small; growth here usually means a role-specific folder is
  missing an abstraction.
