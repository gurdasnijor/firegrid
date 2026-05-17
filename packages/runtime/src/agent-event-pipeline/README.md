# Agent Event Pipeline

`agent-event-pipeline/` groups the clean runtime event-pipeline roles under one
bounded context. It owns live agent byte sources, protocol session providers,
normalized events, pure transforms, and durable runtime output authorities.

The old `session-runtime.ts` composition and runtime subscriber drivers were
deleted by the live-owner cutover; per-context session ownership now lives in
host-sdk `RuntimeContextWorkflowSession` adapters.

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
```

`firegrid-runtime-boundary-reconciliation.CODEC_SESSION.1` and
`firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2` mean the pipeline
selects a concrete scoped session `Layer` from the runtime protocol and then
consumes the active `AgentSession` service from the Effect requirement channel.
It should not accept or retain a codec object with an `open(...)` method.

Runtime codec sessions expose protocol behavior; host-sdk live-owner adapters
wire them to workflow activities and per-context output writers.

## Boundary Rules

- Compose capability tags through Effect requirements and layers.
- Do not hide unresolved layer requirements behind `as Layer<...>` casts.
- Do not construct raw durable rows ad hoc when an event/envelope helper exists.
