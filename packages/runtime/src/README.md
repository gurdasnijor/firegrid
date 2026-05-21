# Runtime Source Boundaries

This directory keeps the agent event-pipeline grouped under
`agent-event-pipeline/`. The target from
[`SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md`](../../../docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md)
is to keep clean event-pipeline roles together while host, waits, tools,
workflow-engine, adapters, and verified ingest remain adjacent bounded
contexts.

The agent event pipeline is:

```txt
agent-event-pipeline/sources -> codecs -> events -> transforms -> subscribers
```

The durable write-owners that the pipeline feeds (the output journal + public
projection) live inside the kernel at [`kernel/observation/`](./kernel/observation/);
the pipeline stages above are the boundary INTO the kernel, not kernel interior.

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
Context.Tag<RuntimeAgentOutputAfterEvents, {
  readonly append: (row: RuntimeEventRow) => Effect.Effect<RuntimeEventRow, E>
}>

// drivers declare needs through the R channel
Effect.Effect<void, ToolRouterError,
  RuntimeAgentOutputEvents | RuntimeToolUseExecutor
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
| [`agent-event-pipeline/subscribers/`](./agent-event-pipeline/subscribers/README.md) | Historical subscriber folder; the live-owner cutover moved prompt/tool routing into the host workflow/session owner. |

(The output write-owners formerly under `agent-event-pipeline/authorities/` now
live in [`kernel/observation/`](./kernel/observation/) — see the kernel boundary
below.)

## The kernel

`kernel/` is the privileged durable core: write-ownership / commit-points for
durable collection families. You do NOT import the kernel directly into a
program — you reach it through drivers that expose channels (see
[`docs/handoffs/tf-8ryo-runtime-tree-design.md`](../../../docs/handoffs/tf-8ryo-runtime-tree-design.md)).
The "authority" Tags are kernel-internal write-ownership, not a public doorway.

- `kernel/control-plane/`: the control-plane recorder (write-owners
  `RuntimeContextInsert`/`RuntimeRuns`/`RuntimeControlRequests` + recorder Live)
  and the request-dispatcher daemon that bridges durable control request rows
  into runtime workflow execution. Host packages provide host-bound side
  effects but do not export or own the dispatcher internals.
- `kernel/observation/`: the agent-output journal write-owner and its public
  projection (`RuntimeAgentOutputAfterEvents`).

There is no directory named `authorities` anywhere; the two formerly
collide-named `authorities/` folders are now `kernel/control-plane` (control
plane) and `kernel/observation` (output).

## Adjacent Runtime Boundaries

These are intentionally not agent event-pipeline stages:

- `host/`: runtime host topology and command entrypoints
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.3`).
- `streams/`: substrate-neutral runtime observation source schemas and
  observation stream capability tags. Consumers such as wait routers and
  future channel registries use this folder for typed stream selection without
  depending on workflow ownership.
- `workflow-engine/`: workflow substrate adapter and runtime-owned workflow
  definitions (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
  Host packages install live workflow Layers and provide topology; they do not
  own workflow names, payload schemas, success/error schemas, or
  idempotency/execution-id helpers.
- `agent-tools/`: tool schemas, lowering, MCP exposure, and host-coupled live
  services.
- `agent-adapters/`: projections over codec sessions
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `verified-webhook-ingest/`: external ingress/source adapter
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).

This namespace move follows the host split and codec session Layer refactor
(`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.5`,
`firegrid-runtime-boundary-reconciliation.SEQUENCING.6`).

If new code does not fit one of the pipeline folder roles, start by classifying
its semantic role instead of adding another convenience folder.
