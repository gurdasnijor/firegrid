# SDD: Effect Pipeline Facade

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Substrate

## Problem

The kernel now has the correct low-level pieces:

- durable rows and StreamDB-backed rebuild;
- durable completion and run state machines;
- semantic producers;
- ready-work derivation;
- raw retained authority folds;
- single-shot operator;
- durable subscribers.

But Fireline/Firepixel runtimes should not have to manually compose those
pieces. A public runtime author should not need to know about claim rows,
retained fold readers, `processReadyWorkItem`, run transition builders, or raw
completion lifecycle CRUD.

The first ergonomic facade should align with Effect:

- dependencies in the `R` channel;
- values over time as `Stream`;
- long-running programs as scoped Effects or Layers;
- expected failures as typed errors;
- side-effect handlers as ordinary Effect functions.

## Proposed API Shape

### Projection

```ts
Projection.snapshot(query)
Projection.stream(query)
Projection.until(query, predicate, options)
```

`Projection.stream` is used for client updates, pending actions, ready work,
and runtime observations. `Projection.until` is the primary wait API for
domain terminal rows.

### Work Pipeline

The claimed-work API should be pipeline-shaped:

```ts
const PromptDispatch =
  Projection.stream(FirelineProjections.prompts.readyToDispatch()).pipe(
    Work.claimedBy(RuntimeIdentity.current, (prompt) => prompt.promptKey),
    Work.perform((prompt) => AgentAdapter.prompt(prompt)),
    Work.recordOutcome((prompt, exit) =>
      FirelinePrompts.recordPromptOutcome(prompt, exit)
    ),
    Work.runScoped,
  )
```

This is the API shape to prove. It is intentionally not:

```ts
ClaimedWork.once({ observe, execute, recordExit })
```

The pipeline makes the cross-cutting boundary visible:

```text
observe candidates
  -> claim before side effect
  -> perform domain effect
  -> record domain outcome from Exit
  -> run under Scope
```

### Awaitable

Awaitable remains narrow:

```ts
Awaitable.timer(...)
Awaitable.scheduled(...)
Awaitable.external(...)
Awaitable.projection(...)
```

Projection-backed waits should use `Projection.until` unless the runtime needs
a durable suspension record independent of the caller process.

## Fireline/Firepixel Fit Checks

### Prompt Await

```ts
const terminal = yield* Projection.until(
  FirelineProjections.prompts.byKey(promptKey),
  FirelinePrompts.isTerminal,
  { timeout: Duration.seconds(60) },
)
```

No durable completion is needed because the domain prompt row is the durable
truth.

### Required Actions

```ts
const pendingActions =
  Projection.stream(FirelineProjections.requiredActions.pending(sessionId))

const decision = yield* Projection.until(
  FirelineProjections.permissions.byId(permissionId),
  FirelinePermissions.isTerminal,
)
```

The UI observes domain state. It should not manipulate raw completion rows.

### Launch And Prompt Dispatch

```ts
const LaunchDispatch =
  Projection.stream(FirelineProjections.launches.ready()).pipe(
    Work.claimedBy(RuntimeIdentity.current, (launch) => launch.launchRequestKey),
    Work.perform((launch) => RuntimeProvider.launchAgent(launch)),
    Work.recordOutcome(FirelineLaunches.recordOutcome),
    Work.runScoped,
  )
```

### Tool Execution

```ts
const ExecuteTool =
  Projection.stream(FirepixelProjections.toolInvocations.ready()).pipe(
    Work.claimedBy(RuntimeIdentity.current, (invocation) => invocation.invocationId),
    Work.perform((invocation) => ToolTransport.invoke(invocation)),
    Work.recordOutcome(FirepixelTools.recordInvocationOutcome),
    Work.runScoped,
  )
```

## Implementation Notes

The facade may wrap existing kernel functions internally:

- `rebuildProjection`;
- `deriveReadyWork`;
- `processReadyWorkItem`;
- retained run/claim authority folds;
- subscriber scan functions;
- `DurableWaits`.

Those functions should not be the normal public API path.

## Open Questions

1. Should `Work.claimedBy` accept an Effectful owner identity provider or only a
   pure owner value?
2. Should `Work.recordOutcome` receive the full `Exit` or separate success and
   failure handlers?
3. Should `Projection.stream` v1 be snapshot-only plus finite test stream, or
   should it require live-follow before being public?
4. Should `Work.runScoped` process sequentially by default, with explicit
   concurrency options later?
