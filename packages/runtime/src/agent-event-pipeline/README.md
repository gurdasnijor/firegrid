# Agent Event Pipeline

`agent-event-pipeline/` groups the clean runtime event-pipeline roles under one
bounded context. It owns live agent byte sources, protocol session providers,
normalized events, pure transforms, and durable runtime output authorities.

Architectural source (the rules below are this folder's enforcement of these):

- [`docs/cannon/architecture/runtime-design-constraints.md`](../../../../docs/cannon/architecture/runtime-design-constraints.md)
- [`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md)

Production path map (which role lives where, and what each path's `R` may /
may not contain): [`TOPOLOGY.md`](./TOPOLOGY.md).

The old `session-runtime.ts` composition and runtime subscriber drivers were
deleted by the live-owner cutover; per-context session ownership now lives in
host-sdk `RuntimeContextWorkflowSession` adapters. The next slice
(`rearch/shape-c-cutover`) replaces the parked `RuntimeContextWorkflowNative`
body with a per-event keyed Shape C subscriber under
[`subscribers/runtime-context/`](./subscribers/runtime-context/README.md).

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
- Protocol-owned schemas (`RuntimeEventRow`, `RuntimeIngressInputRow`, channel
  contracts) stay in `@firegrid/protocol`; they are imported here, never
  redeclared. Moving a protocol schema into a runtime folder is the C7
  violation the topology gate forbids.

## Shape system (and what enforces it)

A subscriber's Effect requirements channel (`R`) declares what kind of
subscriber it is. The shape system tracked in this folder, per
[`runtime-pipeline-type-boundaries.md`](../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md):

- **Shape A** — codec / scoped live boundary (`codecs/`, `sources/`,
  `session-byte-stream-adapter.ts`). `R` = transport/session/id tags only.
- **Shape B** — read-only projection consumer (`subscribers/**` for read-only
  consumers). `R` = a typed read source / `IngressChannel`.
- **Shape C** — keyed stateful subscriber, **no workflow machinery**
  (`subscribers/runtime-context/` is the cutover landing zone). `R` includes a
  state-store tag and live/channel tags; **must not include** `WorkflowEngine.*`.
- **Shape D** — workflow-shaped subscriber, justified by `Activity.make` /
  `DurableDeferred` / `DurableClock` machinery (`tool-execution/`, the
  correctly-shaped D workflows in `workflow-engine/workflows/`). `R` includes
  `WorkflowEngine.WorkflowEngine` / `WorkflowEngine.WorkflowInstance`.

Gates (semgrep, tf-zchu — see `.semgrep.yml`):

- `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber` blocks
  `Activity.make`, `Workflow.suspend`, `Workflow.execute`, and
  `WorkflowEngine.WorkflowEngine` / `WorkflowEngine.WorkflowInstance` inside
  `subscribers/runtime-context/**`.
- `firegrid-transforms-no-effect-shaped-exports` (**follow-up; review-enforced
  today**) would block `Effect.gen`, `Effect.{succeed,fail,sync,tryPromise,promise,async}`,
  `Layer.*`, `Workflow.make`, `Activity.make`, `DurableDeferred.*`, and
  `Context.{Tag,GenericTag}` inside `transforms/**`. The pattern is drafted;
  the CI rule did not land in this slice because of a `semgrep --test` quirk
  documented in [`TOPOLOGY.md`](./TOPOLOGY.md).
