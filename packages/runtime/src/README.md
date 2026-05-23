# Runtime Source Boundaries

## Shape C Cutover Target Tree

The Shape C cutover target layout is pinned at
[`docs/architecture/2026-05-22-runtime-physical-target-tree.md`](../../../docs/architecture/2026-05-22-runtime-physical-target-tree.md).

This scaffold PR stages the empty target folders alongside the pre-cutover
layout below. Each new folder carries a README documenting what it owns, its
logical pipeline position (`events` < `tables` < `producers` / `transforms` /
`channels` < `subscribers` < `composition`), and the import-direction rule.
Subscriber folders declare their shape (`SHAPE: B | C | D`) in their README.

### Target Surfaces (semantic, first-class)

The script `scripts/runtime-public-surface-check.mjs` enforces that each of
the surfaces below exists and is documented here:

| Folder | Role | Logical position |
|---|---|---|
| [`events/`](./events/README.md) | event vocabulary; pure schemas, no I/O. | 1 |
| [`tables/`](./tables/README.md) | DurableTable-backed state of record. | 2 |
| [`producers/`](./producers/README.md) | Shape A live-boundary appenders (`sandbox/`, `codecs/`, `ingress-writers/`). | 3 |
| [`transforms/`](./transforms/README.md) | pure row/event transforms; no `Effect`. | 4 |
| [`channels/`](./channels/README.md) | wire-edge capability boundary (`host-control/`, `session/`, `routes/`, `router.ts`). | 5 |
| [`subscribers/`](./subscribers/README.md) | keyed subscribers — Shape B/C/D recorded in folder READMEs. | 6 |
| [`composition/`](./composition/README.md) | runtime-local layer-graph wiring + topology checks. | 7 |
| [`_archive/`](./_archive/DEPRECATED.md) | time-boxed holding pen for wrong-shape code pending deletion. | — |

Folder names are semantic. Numeric prefixes are forbidden at the runtime
root; the public-surface guard rejects any `^[0-9]+-` top-level directory.

Wave 1 forward-target re-exports landed in this scaffold:

- `tables/runtime-context-state.ts` →
  `@firegrid/runtime/tables/runtime-context-state`
- `subscribers/runtime-context-session/index.ts` →
  `@firegrid/runtime/subscribers/runtime-context-session`

The host-sdk import gate (Semgrep rule
`firegrid-host-sdk-no-runtime-kernel-import` and friends) blocks new host-sdk
imports of `@firegrid/runtime/kernel`, `_archive/`, and any numbered runtime
subpath. Existing kernel-barrel sites are baselined as legacy debt; they
shrink as host-sdk callers migrate to the semantic subpaths above.

## Pre-Cutover Layout (Active)

This directory keeps the agent event-pipeline grouped under
`agent-event-pipeline/`. The target from
[`SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md`](../../../docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md)
is to keep clean event-pipeline roles together while host, kernel, waits, tools,
workflow-engine, adapters, and verified ingest remain adjacent bounded
contexts.

The agent event pipeline is:

```txt
agent-event-pipeline/sources -> codecs -> events -> transforms -> authorities -> subscribers
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
| [`agent-event-pipeline/authorities/`](./agent-event-pipeline/authorities/) | Durable Effect capability providers for runtime output/ingress. |
| [`agent-event-pipeline/subscribers/`](./agent-event-pipeline/subscribers/README.md) | Runtime subscriber landing zone. The Shape C RuntimeContext per-event handler lives under `subscribers/runtime-context/`; Shape B projection consumers may live alongside as siblings. The Shape C subscribers' `R` channel must not name `WorkflowEngine`/`WorkflowInstance` (enforced by `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`). See [`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md) §"Shape C" and `agent-event-pipeline/TOPOLOGY.md`. |

## Adjacent Runtime Boundaries

These are intentionally not agent event-pipeline stages:

- `host/`: runtime host topology and command entrypoints
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.3`).
- `streams/`: substrate-neutral runtime observation source schemas and
  observation stream capability tags. Consumers such as wait routers and
  future channel registries use this folder for typed stream selection without
  depending on workflow ownership.
- `runtime-keyed-subscriber/`: the Shape C subscriber-runtime dispatch
  primitive. A generic per-key event router: tails a keyed-event source,
  serializes same-key handlers via a per-key mutex, runs different keys
  concurrently (optionally bounded). Imposes no `WorkflowEngine` requirement
  on the subscriber's `R`. Production manifestation of the tf-4fy3 Outcome B
  evidence; downstream Shape C handler lanes (RuntimeContext, tool-result
  routing) compose this primitive with their typed event sources and keyed
  handlers.
- `channels/`: public runtime channel router capabilities. The implementation
  lives in runtime authority/provider modules; this folder is the stable import
  surface for route metadata and dispatch composition.
- `kernel/`: runtime-context host-kernel services that own workflow execution
  helpers, host-scoped workflow engine lifecycle, runtime host config, and
  input dispatch state. Host packages compose these services but do not own
  their durable workflow/runtime implementation.
- `workflow-engine/`: workflow substrate adapter and runtime-owned workflow
  definitions (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
  Host packages install live workflow Layers and provide topology; they do not
  own workflow names, payload schemas, success/error schemas, or
  idempotency/execution-id helpers.
- `control-plane/`: runtime-owned dispatcher/daemon mechanics that bridge
  durable control request rows into runtime workflow execution. Host packages
  provide host-bound side effects, but they do not export or own the dispatcher
  internals.
- `agent-tools/`: tool schemas, lowering, MCP exposure, and host-coupled live
  services.
- `agent-adapters/`: projections over codec sessions
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `verified-webhook-ingest/`: external ingress/source adapter
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.4`).
- `authorities/`: runtime control-plane lifecycle capabilities
  (`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.2`).
- `channels/`: the durable channel Live implementations (tf-bffo). protocol
  owns the channel contracts/Tags; the runtime owns these durable Live bindings
  (reached above-box only through channels); host-sdk only COMPOSES them by
  injecting host topology config. This is the doorway-enforcing co-location: the
  durable channel implementations live below the substrate boundary, not in
  host-sdk.

This namespace move follows the host split and codec session Layer refactor
(`firegrid-runtime-boundary-reconciliation.NAMESPACE_BOUNDARY.5`,
`firegrid-runtime-boundary-reconciliation.SEQUENCING.6`).

If new code does not fit one of the pipeline folder roles, start by classifying
its semantic role instead of adding another convenience folder.
