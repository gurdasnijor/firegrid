# Runtime Subscribers

`subscribers/` contains host-scoped drivers over durable runtime observations.
Subscribers consume `Stream` capability tags and perform side effects through
narrow durable write capabilities or active codec/session capabilities.

## Pipeline Fit

Subscribers react after durable observations exist:

```txt
authorities -> subscribers -> authorities/codecs
```

The legacy ingress-delivery, tool-router, and stderr-journal subscribers were
deleted by the live-owner cutover. The Shape C rearch (2026-05-22) places new
target-shape subscribers back under this folder: `runtime-context/` is the
canonical home for the per-event Shape C RuntimeContext subscriber
(`handler.ts` + `subscriber.ts`), driven by `runtime-keyed-subscriber`'s
`runKeyedDispatch` over the typed sources in `authorities/` (input facts,
state-relevant output observations).

Subscriber shape:

```ts
Layer.Layer<never, WaitRouterError,
  SourceCollections | DurableWaitIntentRows | DurableWaitCompletionUpsert
>
```

The important part is the requirement channel: a subscriber can read its
declared observations and write through narrow capabilities, but it cannot
mutate unrelated tables, deliver stdin, or access table facades. Composition
supplies the capabilities.

Long-running drivers that provide no public service can also be modeled as
scoped layers:

```ts
Layer.Layer<never, WaitRouterError,
  SourceCollections | DurableWaitIntentRows | DurableWaitCompletionUpsert
>
```

That shape means "start this driver for its scope." It does not create a
service other code should call.

## Shape rule

A file in this folder is one of:

- **Shape B** — read-only projection consumer. `R` only mentions a typed read
  source / `IngressChannel`. No state stores, no `*Write` / `EgressChannel`, no
  `WorkflowEngine`.
- **Shape C** — keyed stateful subscriber. `R` includes a state-store tag (it
  OWNS state for that key kind) plus the narrow live/channel tags it dispatches
  through. **`WorkflowEngine.WorkflowEngine` / `WorkflowEngine.WorkflowInstance`
  MUST NOT appear in `R`.** Shape C handlers materialize for one event, load
  state, run a pure transition from [`../transforms/`](../transforms/README.md),
  save, dispatch actions, return. They do not park on multiple semantic wait
  kinds, do not scan dense raw output, and do not have a context-lifetime body.

The Shape C RuntimeContext cutover lands under
[`runtime-context/`](./runtime-context/README.md). That directory is gated by
`firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber` — see
[`../TOPOLOGY.md`](../TOPOLOGY.md) and
[`docs/cannon/architecture/runtime-design-constraints.md`](../../../../../docs/cannon/architecture/runtime-design-constraints.md).

A subscriber that genuinely needs `Activity.make` / `DurableDeferred` /
`DurableClock` is **Shape D** and belongs in [`../tool-execution/`](../tool-execution/),
not here.

## Boundary Rules

- Depend on `Stream` capability tags, not table facades.
- Write through narrow capability tags.
- Keep protocol-specific send behavior in codecs or active session
  capabilities.
- Keep generic wait routing in `waits/`; it is subscriber-shaped but wait-owned
  because its vocabulary is wait rows and source handles, not agent events.
- Do not import from `workflow-engine/**` here. If you need workflow machinery,
  the subscriber is Shape D and belongs in `tool-execution/` or under a
  justified `workflow-engine/workflows/` landing.
