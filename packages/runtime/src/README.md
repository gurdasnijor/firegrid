# Runtime Source Boundaries

This directory keeps the agent event-pipeline grouped under
`agent-event-pipeline/`. The target from
[`SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md`](../../../docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md)
is to keep clean event-pipeline roles together while host, waits, tools,
workflow-engine, adapters, and verified ingest remain adjacent bounded
contexts.

The agent event pipeline is:

```txt
agent-event-pipeline/sources -> codecs -> events -> transforms -> authorities -> subscribers
                                                        \                         /
                                                         session-runtime
```

The arrows describe ownership of data flow, not import permission. Durable
state is owned by capability provider layers, and runtime behavior composes
ordinary Effect surfaces (`Context.Tag`, `Layer`, `Queue.Enqueue`, `Stream`,
`Sink`, and narrow `Effect` services). Avoid adding Firegrid-specific wrapper
types when an Effect surface already describes the role.

## Effect-Native Type Shape

The pipeline is intentionally built from small Effect traits:

```ts
// producer can only enqueue durable rows
Context.Tag<RuntimeEventLog, Queue.Enqueue<RuntimeEventRow>>

// observer can only subscribe to committed rows
Context.Tag<RuntimeOutputEvents, Stream.Stream<RuntimeEventRow, E>>

// richer command gets a named method, not a new framework
Context.Tag<RuntimeEventAppendAndGet, {
  readonly append: (row: RuntimeEventRow) => Effect.Effect<RuntimeEventRow, E>
}>

// drivers declare needs through the R channel
Effect.Effect<void, ToolRouterError,
  RuntimeAgentOutputEvents | RuntimeIngressAppendAndGet
>
```

The tag name carries the durability promise; the service shape stays ordinary
Effect. If code needs a second bespoke "runtime authority" or "runtime
transform" abstraction, the boundary is probably misclassified.

## Load-Bearing Pipeline Folders

| Folder | Role |
| --- | --- |
| [`agent-event-pipeline/sources/`](./agent-event-pipeline/sources/README.md) | Live byte/process/resource acquisition. |
| [`agent-event-pipeline/codecs/`](./agent-event-pipeline/codecs/README.md) | Protocol wire-format normalization. |
| [`agent-event-pipeline/events/`](./agent-event-pipeline/events/README.md) | Normalized runtime event contracts and envelope helpers. |
| [`agent-event-pipeline/transforms/`](./agent-event-pipeline/transforms/README.md) | Pure stream/row shaping operators. |
| [`agent-event-pipeline/authorities/`](./agent-event-pipeline/authorities/) | Durable Effect capability providers for runtime output/ingress. |
| [`agent-event-pipeline/subscribers/`](./agent-event-pipeline/subscribers/README.md) | Host-scoped drivers over durable observations. |
| [`agent-event-pipeline/session-runtime.ts`](./agent-event-pipeline/session-runtime.ts) | Per-session event-loop composition. |

## Adjacent Runtime Boundaries

These are intentionally not agent event-pipeline stages:

- `host/`: runtime host topology and command entrypoints
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.3`).
- `waits/`: durable coordination operator and wait-owned router
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `workflow-engine/`: workflow substrate adapter
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `agent-tools/`: tool schemas, lowering, MCP exposure, and host-coupled live
  services.
- `agent-adapters/`: projections over codec sessions
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `verified-webhook-ingest/`: external ingress/source adapter
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `authorities/`: runtime control-plane lifecycle capabilities
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.2`).

This namespace move follows the host split and codec session Layer refactor
(`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.5`,
`firegrid-runtime-boundary-reconciliation.SEQUENCING.6`).

If new code does not fit one of the pipeline folder roles, start by classifying
its semantic role instead of adding another convenience folder.
