# subscribers/

Logical pipeline position: **6**. May import `events/`, `tables/`,
`producers/`, `transforms/`, and `channels/`. Must not import `composition/`.

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
| C | state-store tag + relevant channel tags + clock | `WorkflowEngine`, `WorkflowInstance`, `Activity.make`, parked body, replay-based progress |
| D | C-allowed + `WorkflowEngine`/`WorkflowInstance` *with README justification* | undocumented use of workflow machinery |

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

- `events/`, `tables/`, `producers/`, `transforms/`, `channels/`
- protocol schemas, channel contracts
- `effect`, `@effect/workflow` (Shape D folders only — see justification rule)

## Must not import

- `composition/`
- Shape B: state store tags, write authority tags, workflow machinery
- Shape C: `WorkflowEngine`, `WorkflowInstance`, `Activity.make`,
  `DurableDeferred` (enforced by the Shape C topology check)
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
