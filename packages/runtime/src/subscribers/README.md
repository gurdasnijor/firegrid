# subscribers/

Logical pipeline position: **6**. May import `events/`, `tables/`,
`transforms/`, and `channels/`. Must not import `producers/` or
`composition/`.

Subscribers consume durable rows through table read sources and channel
tags; they do not import producer append authorities or live producer code.
A subscriber that needs a side effect goes through a channel binding or a
narrow capability tag, not directly through a producer module.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
`docs/cannon/architecture/runtime-design-constraints.md`.

## Owns

Keyed subscribers. A subscriber reads rows for one entity key, optionally
writes more rows, and returns. The subscriber's **shape** is recorded in its
folder README (`SHAPE: B`, `SHAPE: C`, or `SHAPE: D — <justification>`) and in
the PR title. Shape is not encoded in the directory name.

| Shape | Allowed in `R` channel | Forbidden in `R` |
|---|---|---|
| B | typed observation source tags | state stores, write authority, `WorkflowEngine`/`WorkflowInstance` |
| C | state-store tag + relevant channel tags | `WorkflowEngine`, `WorkflowInstance`, `Activity.make`, `DurableDeferred`, `DurableClock`, parked body, replay-based progress |
| D | C-allowed + `WorkflowEngine`/`WorkflowInstance` *with README justification* | undocumented use of workflow machinery |

Notes on time and timers:

- **Shape C must not use `DurableClock`, `DurableDeferred`, or any workflow
  machinery.** Durable timers and durable wait are load-bearing Shape D
  capabilities (`scheduled-prompt/`, `wait-router/`).
- If a Shape C subscriber legitimately needs to read the current time
  (logging, deterministic ordering tags) it does so through `effect/Clock`
  via Effect's default services. The plain `Clock` is not the same as
  `DurableClock` and is not part of the Shape-C `R` channel inventory; it
  is called out explicitly in the subscriber's README when used.

Current subscriber folders:

| Folder | Shape | Notes |
|---|---|---|
| `projections/` | B | read-only consumers |
| `runtime-context/` | C | stateful per-event RuntimeContext handler |
| `runtime-context-session/` | C | codec-session command-sink (`RuntimeContextWorkflowSession`) |
| `tool-dispatch/` | D | Activity memoization for tool-use side effects |
| `wait-router/` | D | durable wait/timeout |
| `scheduled-prompt/` | D | `DurableClock` deadline |
| `runtime-control/` | D | host-control request workflows |

## May import

- `events/`, `tables/`, `transforms/`, `channels/`
- protocol schemas, channel contracts
- `effect`, `@effect/workflow` (Shape D folders only — see justification rule)

## Must not import

- `producers/` — subscribers consume durable rows via table reads and channel
  tags; producer append authorities are not subscriber dependencies
- `composition/`
- Shape B: state store tags, write authority tags, workflow machinery
- Shape C: `WorkflowEngine`, `WorkflowInstance`, `Activity.make`,
  `DurableDeferred`, `DurableClock` (enforced by the Shape C topology check)
- Shape D: workflow machinery without a README naming the load-bearing reason

## DO

```ts
// runtime-context/handler.ts
// README declares: SHAPE: C
export const handleRuntimeContextEvent = (
  context: RuntimeContext,
  event: AgentInputEvent | RuntimeAgentOutputObservation,
): Effect.Effect<
  void,
  never,
  RuntimeContextStateStore | SessionAgentOutputChannel
> => Effect.gen(/* point-read state -> transition -> point-write state + actions */)
```

## DO NOT

```ts
// runtime-context/handler.ts
// README declares: SHAPE: C — must not use workflow machinery
export const handleRuntimeContextEvent = Effect.gen(function* () {
  const memo = yield* Activity.make(/* ... */)         // not allowed in Shape C
  while (true) {
    const next = yield* DurableDeferred.await(/* ... */) // parked body — wrong shape
  }
})
```

## Scaffold status

All seven subscriber subfolders are staged with `SHAPE:`-declared READMEs.
Wave 2 moves:

- `agent-event-pipeline/subscribers/runtime-context/` → `subscribers/runtime-context/`
- codec-session sink → `subscribers/runtime-context-session/`
- `workflow-engine/workflows/tool-call.ts` → `subscribers/tool-dispatch/`
- `workflow-engine/workflows/wait-for.ts` → `subscribers/wait-router/`
- `workflow-engine/workflows/scheduled-prompt.ts` → `subscribers/scheduled-prompt/`
- `workflow-engine/workflows/runtime-control-request.ts` → `subscribers/runtime-control/`

Reserved public subpaths (Wave 2 export targets):

```text
@firegrid/runtime/subscribers/runtime-context
@firegrid/runtime/subscribers/runtime-context-session
```

`runtime-context-session/index.ts` already ships as the Wave 1 forward-target
re-export of the runtime-owned command-sink tag/types.
