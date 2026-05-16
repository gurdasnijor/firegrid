# Agent Event Pipeline

`agent-event-pipeline/` groups the clean runtime event-pipeline roles under one
bounded context. It owns live agent byte sources, protocol session providers,
normalized events, pure transforms, durable runtime output/ingress
authorities, subscriber drivers, and per-session runtime composition.

`session-runtime.ts` is composition, not a stage.

Boundary evidence:

- `firegrid-runtime-boundary-reconciliation.ROLE_MODEL.8`
- `firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.1`
- `firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.6`

## Pipeline Fit

This namespace wires the stage roles together for a running codec session:

```txt
sources -> codecs -> transforms -> authorities
                         |
                         v
                    subscribers
```

`session-runtime.ts` may open sessions, fork scoped subscribers, run row
streams through durable sinks, and return terminal evidence. It should not
define new domain concepts that belong in role-specific folders.

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

The session runtime wires live capabilities together. It should not make static
decisions that belong to codec sessions, and it should not write durable rows
except through authority tags.

## Boundary Rules

- Compose capability tags through Effect requirements and layers.
- Do not hide unresolved layer requirements behind `as Layer<...>` casts.
- Do not construct raw durable rows ad hoc when an event/envelope helper exists.
- Keep `session-runtime.ts` small; growth there usually means a role-specific
  folder is missing an abstraction.
