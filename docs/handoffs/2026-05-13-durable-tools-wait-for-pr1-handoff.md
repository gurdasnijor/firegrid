# Firegrid Handoff: Durable Tools `wait_for` (PR 1)

**Date:** 2026-05-13
**Status:** Implementation handoff for the Coding Agent.
**Spec:** `features/firegrid/firegrid-durable-tools.feature.yaml`
**SDD:** `docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md`
**Spec PR:** https://github.com/gurdasnijor/firegrid/pull/169
**Repo:** `/Users/gnijor/gurdasnijor/firegrid`

This handoff is the implementation brief for the first concrete durable-tools
PR. The spec is law; this doc translates the 51 ACIDs into a concrete module
layout, types, and test matrix without re-deciding any of the design choices
that are already pinned. Where the spec and this handoff disagree, the spec
wins.

## Required Reading (in order)

1. `features/firegrid/firegrid-durable-tools.feature.yaml`
2. `docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md`
3. `docs/architecture/managed-agent-runtime-target-durable-facts.md`
4. `packages/effect-durable-operators/src/DurableTable.ts`
5. `packages/protocol/src/launch/table.ts` — the strict composite-key pattern
   to mirror
6. `packages/runtime/src/workflow-engine/internal/engine-runtime.ts` — engine
   `deferredDone` shape and the existing `clockWakeups`/clock pattern to align
   with (without manipulating it directly)
7. `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts`
   — the durable-restart test pattern this PR's restart test must follow

## Pinned Design Decisions (from coordinator)

These are **not** open. Do not re-litigate.

- Sleep is not a separate tool. `DurableClock.sleep` + the workflow clock
  path already cover duration waits.
- `wait_for` is the first durable-tools PR.
- `wait_for` resolves a workflow-engine deferred on an **already-running**
  workflow execution. It does not dispatch or start new workflows.
- No `executeByName` / `WorkflowDispatchService` / workflow-name registry.
- Trigger DSL is AND-of-scalar `fieldEquals`. No OR (inside one subscription),
  NOT, range, lambda, contains, or defaulted path traversal.
- Source subscription uses `subscribeChanges(..., { includeInitialState: true })`.
  No snapshot-then-subscribe.
- Pause/retire is a per-dispatch wait-row status re-check. No dynamic fiber
  registry. No `paused` status; the v0 enum is `active` / `completed` /
  `timed_out` / `retired`.
- Composite primary keys use `Schema.transformOrFail` to a JSON-tuple string
  (the `protocol/src/launch/table.ts` convention). The `RuntimeInputDeliveryKey`
  separator pattern is not extended.
- The router writes/completes deferreds with the **raw** matched-row payload.
  `wait_for` performs call-site decoding through the caller-supplied Effect
  Schema. The router does not own call-site schemas or a schema registry.
- The wait completion row is **authoritative** for resolution. Router startup
  reconciles completed waits with an idempotent `deferredDone` call, so a
  crash between completion-row write and deferred resume does not strand a
  wait.
- v0 uses only the `waits` and `completions` collections. There is no
  separate `subscriptions` collection in PR 1.

## Target Module Layout

All new code lives under `@firegrid/runtime`. No new top-level package.

```text
packages/runtime/src/durable-tools/
  index.ts                              # public exports
  DurableToolsWaitFor.ts                # public Layer + service tag class
  internal/
    keys.ts                             # WaitKey via Schema.transformOrFail
    table.ts                            # DurableToolsTable: waits + completions
    types.ts                            # FieldEqualsTrigger, WaitOutcome, errors
    source-collections.ts               # registry: source name -> typed facade
    wait-for.ts                         # wait_for workflow-handler API
    subscription-router.ts              # scoped runtime worker
    reconcile.ts                        # crash-recovery loop on startup
```

`@firegrid/protocol` is **not** edited. The wait/completion table contract
stays runtime-private until a browser/edge surface is proven to need it
(BOUNDARIES.9, RUNTIME_BOUNDARY.2).

## Table Schema (waits + completions only)

```ts
// internal/keys.ts — firegrid-durable-tools.BOUNDARIES.6
const WaitKey = Schema.transformOrFail(
  Schema.String,
  Schema.Struct({ executionId: Schema.String, name: Schema.String }),
  {
    strict: false,
    decode: (encoded, _opts, ast) =>
      ParseResult.flatMap(parseJsonTuple(encoded, 2, ast), (parts) => {
        if (typeof parts[0] !== "string" || typeof parts[1] !== "string") {
          return ParseResult.fail(new ParseResult.Type(ast, encoded,
            "WaitKey tuple must be [executionId, name]"))
        }
        return ParseResult.succeed({ executionId: parts[0], name: parts[1] })
      }),
    encode: ({ executionId, name }) =>
      ParseResult.succeed(JSON.stringify([executionId, name])),
  },
)

// internal/types.ts
const FieldEqualsTriggerSchema = Schema.Array(Schema.Struct({
  path: Schema.Array(Schema.String),
  equals: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
}))
type FieldEqualsTrigger = Schema.Schema.Type<typeof FieldEqualsTriggerSchema>

const WaitStatusSchema = Schema.Literal(
  "active", "completed", "timed_out", "retired",
)

// internal/table.ts
const WaitRowSchema = Schema.Struct({
  waitKey:        WaitKey.pipe(DurableTable.primaryKey),
  executionId:    Schema.String,
  deferredName:   Schema.String,
  sourceName:     Schema.String,
  trigger:        FieldEqualsTriggerSchema,
  status:         WaitStatusSchema,
  createdAtMs:    Schema.Number,
  deadlineMs:     Schema.optional(Schema.Number),
})

const WaitOutcomeSchema = Schema.Literal("match", "timeout")

const WaitCompletionRowSchema = Schema.Struct({
  waitKey:           WaitKey.pipe(DurableTable.primaryKey),
  outcome:           WaitOutcomeSchema,
  matchedRowPayload: Schema.optional(Schema.Unknown),  // raw; wait_for decodes
  completedAtMs:     Schema.Number,
})

const durableToolsSchemas = {
  waits:       WaitRowSchema,
  completions: WaitCompletionRowSchema,
} as const

export class DurableToolsTable extends DurableTable(
  "firegrid.durableTools",
  durableToolsSchemas,
) {}
```

Notes:

- One declaration. No client/runtime duplicate (BOUNDARIES.9).
- All timestamps via `Clock.currentTimeMillis` at the call site (EFFECT_IDIOMS.2).
- Writes go through `DurableTable`'s generated `upsert`. No raw stream append
  helpers (BOUNDARIES.7).

## Source-Collection Registry

```ts
export interface SourceCollectionHandle<Row extends object> {
  readonly name: string
  readonly facade: CollectionFacade<Row, unknown>
}

export interface SourceCollections {
  readonly register: <Row extends object>(
    handle: SourceCollectionHandle<Row>,
  ) => Effect.Effect<void>
  readonly lookup: (
    name: string,
  ) => Effect.Effect<Option.Option<SourceCollectionHandle<object>>>
}
```

The registry is provided once per runtime-host scope. Runtime-host code
registers source facades by typed handle reference. The registry does **not**
accept raw Durable Streams URLs, `@durable-streams/*` client objects, or
stream metadata (RUNTIME_BOUNDARY.3).

## Public API Shape (`wait_for`)

```ts
export type WaitForOutcome<A> =
  | { readonly _tag: "Match";   readonly row: A }
  | { readonly _tag: "Timeout" }

export interface WaitForOptions<A> {
  readonly name: string                       // unique within executionId
  readonly source: string                     // registered source-collection name
  readonly trigger: FieldEqualsTrigger        // AND-of-scalar-equality
  readonly resultSchema?: Schema.Schema<A>    // call-site decode; firegrid-durable-tools.WAIT_FOR.3
  readonly timeoutMs?: number                 // optional; firegrid-durable-tools.TIMEOUT.1
}

export const WaitFor: {
  readonly match: <A = unknown>(
    options: WaitForOptions<A>,
  ) => Effect.Effect<
    WaitForOutcome<A>,
    WaitForError | ParseResult.ParseError,
    | WorkflowEngine.WorkflowInstance
    | DurableToolsTable
    | SourceCollections
  >
}
```

- `name` + `executionId` form the deterministic `WaitKey` (WAIT_FOR.2).
- `resultSchema` is decoded against the deferred's raw matched-row payload
  on resume (WAIT_FOR.3). If omitted, the caller is opting into `unknown`.
- The returned discriminated union lets callers branch with `Match.tag`
  (EFFECT_IDIOMS.3, WAIT_FOR.4).

## Router Behavior

The router is a scoped runtime worker. It is composed by the runtime host
Layer alongside the workflow engine and ingress layers (RUNTIME_BOUNDARY.4,
SUBSCRIPTION.7).

```text
acquire (scope):
  startup reconciliation pass:
    query DurableToolsTable.completions where (waitKey not yet observed-done)
    for each: call engine.deferredDone idempotently        # WAIT_FOR.7
  attach to DurableToolsTable.waits.subscribeChanges(
    { includeInitialState: true },                          # SUBSCRIPTION.1
  )
  for each active wait row:
    look up source facade in SourceCollections
    attach to source.subscribeChanges(
      { includeInitialState: true },                        # SUBSCRIPTION.1
    )
    for each row change:
      let current = DurableToolsTable.waits.get(waitKey)    # LIFECYCLE.2
      if current.status !== "active": skip                  # LIFECYCLE.3
      if !evaluateFieldEquals(trigger, row): skip
      let nowMs = yield* Clock.currentTimeMillis
      yield* DurableToolsTable.completions.upsert({
        waitKey, outcome: "match",
        matchedRowPayload: row,                              # SUBSCRIPTION.3
        completedAtMs: nowMs,
      })
      yield* DurableToolsTable.waits.upsert({
        ...current, status: "completed",
      })
      yield* engine.deferredDone(
        DurableDeferred.make(current.deferredName),
        { workflowName, executionId, deferredName,
          exit: Exit.succeed(row) },                         # raw row, not decoded
      )
```

Key invariants:

- Initial state and live changes flow through a single match-evaluation code
  path (SUBSCRIPTION.1).
- No snapshot-then-subscribe (SUBSCRIPTION.2).
- No `Effect.sleep` polling loops over `.get`; the discovery channel is
  `.subscribeChanges` only (BOUNDARIES.3).
- The router never decodes against a call-site schema (SUBSCRIPTION.3 ¶2).
- The router never starts a workflow execution (PUBLIC_SURFACE.1/2).
- A retired wait observed at re-check produces no completion (LIFECYCLE.3,
  LIFECYCLE.5).

## Timeout Path

Use the existing `@effect/workflow` clock semantics (TIMEOUT.1). The simplest
shape that satisfies the spec:

- `wait_for` constructs a `DurableDeferred.make(name)` for the match path.
- If `timeoutMs` is set, `wait_for` races the deferred await against
  `DurableClock.sleep({ name: \`${name}.timeout\`, duration: Duration.millis(timeoutMs) })`.
- If the clock wakes first, `wait_for` writes the timeout completion row and
  upserts the wait row to `status: "timed_out"` before returning the
  `{ _tag: "Timeout" }` branch.
- If the deferred resolves first, the racing sleep is interrupted by Effect's
  race semantics; no further action is needed on the sleep side.
- A late timeout firing that observes the wait already in
  `status: "completed"` re-checks and becomes a no-op (TIMEOUT.4,
  LIFECYCLE.2).
- The router does **not** manipulate `clockWakeups` rows or
  `fireDueWorkflowClocks` directly (TIMEOUT.1 ¶2).
- No `ToolTimersTable` is introduced (TIMEOUT.1 ¶3).

If `Effect.race` of a `DurableDeferred.await` with a `DurableClock.sleep`
turns out to need additional plumbing inside `@effect/workflow`, escalate
to coordinator before deviating from this shape — do not invent a parallel
clock surface.

## Crash Recovery (WAIT_FOR.7)

The wait completion row is the authoritative record. The router's startup
reconciliation pass is the recovery mechanism:

```text
on scope acquire, before subscribing:
  for each row in DurableToolsTable.completions:
    let wait = DurableToolsTable.waits.get(row.waitKey)
    if wait.status === "completed" || wait.status === "timed_out":
      let exit = row.outcome === "match"
        ? Exit.succeed(row.matchedRowPayload)
        : Exit.succeed({ _tag: "Timeout" })
      yield* engine.deferredDone(
        DurableDeferred.make(wait.deferredName),
        { workflowName, executionId: wait.executionId,
          deferredName: wait.deferredName, exit },
      )
```

`engine.deferredDone` is already idempotent in the engine (see
`engine-runtime.ts:263-277` — it upserts only when `Option.isNone(existingDeferred)`).
Recovery therefore relies on existing engine semantics; the router only
re-issues the call.

## Composition (Runtime Host Wiring)

The Layer story:

```ts
// DurableToolsWaitFor.ts — public Layer entrypoint
export const DurableToolsWaitForLive = (options: {
  readonly streamUrl: string
}) => Layer.mergeAll(
  DurableToolsTable.layer({
    streamOptions: { url: options.streamUrl, contentType: "application/json" },
  }),
  SourceCollections.layer,
  SubscriptionRouter.layer,        // forks the scoped worker
)
```

`SubscriptionRouter.layer` is a `Layer.scoped` that forks the router fiber
into the runtime-host scope (matches the workflow-engine-table layer pattern).

The runtime host composes this Layer alongside the existing workflow-engine
Layer and ingress Layer. Source-collection registration happens once per
runtime host startup, before any wait_for-bearing workflow is executed.

## Test Matrix (it.effect only)

| Test | ACID(s) directly proven |
|---|---|
| Workflow emits request row, waits, external producer appends matching row, workflow resumes once with typed value decoded from raw payload | WAIT_FOR.1, WAIT_FOR.3, WAIT_FOR.6, SUBSCRIPTION.1, SUBSCRIPTION.3 |
| Restart: emit request, kill engine, append matching row, restart engine + router, recovery pass + live match resolves the wait | WAIT_FOR.6, WAIT_FOR.7, SUBSCRIPTION.1 |
| Crash-after-completion-row recovery: write completion row directly, kill before deferredDone, restart router, reconciliation calls idempotent deferredDone, workflow returns | WAIT_FOR.7 |
| Timeout fires before any match → outcome `Timeout`, wait status `timed_out` | TIMEOUT.1, TIMEOUT.2, WAIT_FOR.4 |
| Match preempts pending timeout → single resolution, late clock wake is a no-op | TIMEOUT.3, TIMEOUT.4 |
| Retired wait: mark `retired` before match arrives → no completion row, no deferred resume | LIFECYCLE.2, LIFECYCLE.3 |
| Initial-state replay: source row already present when wait is created → resolves once, not twice | SUBSCRIPTION.1, WAIT_FOR.6 |
| Tagged-union row payload `Union(Succeeded, Failed)` matched on `requestId`; handler discriminates by `_tag` via `Match.tag` | EFFECT_IDIOMS.3, WAIT_FOR.3, WAIT_FOR.4 |
| Two active waits on the same source resolve independently | LIFECYCLE.4, SUBSCRIPTION.7 |
| Composite-key parse: malformed wait-key string returns `ParseResult.fail`; valid JSON tuple round-trips | BOUNDARIES.6 |
| Tests inspect persisted rows through production `DurableToolsTable` declaration; no test-only state store | EFFECT_IDIOMS.5 |
| Subscription router uses one `subscribeChanges(..., { includeInitialState: true })` per source; no snapshot query before subscribe | SUBSCRIPTION.1, SUBSCRIPTION.2 |
| `wait_for` does not call any workflow-engine method that starts an execution; sanity-check via spy / no-call assertion | PUBLIC_SURFACE.1, PUBLIC_SURFACE.2 |

Use a real local `@durable-streams` server. Mirror the setup in
`packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts`
for restart/recovery proofs (VALIDATION.3 clock pattern is the template).

## Hard Rejects (paste into the implementation prompt verbatim)

- ❌ No new top-level package. Live under `packages/runtime/src/durable-tools/`.
- ❌ No `@durable-streams/*` imports in `@firegrid/protocol`.
- ❌ No revival of `DurableConsumer`, `ConsumerSource`, `ConsumerCheckpointStore`,
  `DurableProjection` under new names (e.g., `WaitConsumer`, `SubscriptionEngine`,
  `ProjectionMatcher`).
- ❌ No public `executeByName`, `WorkflowDispatchService`, or workflow-name
  registry. Resolve deferreds; do not start workflows.
- ❌ No snapshot-then-subscribe. Use `subscribeChanges(..., { includeInitialState: true })`.
- ❌ No separate `subscriptions` collection. v0 = `waits` + `completions` only.
- ❌ No `ToolTimersTable`. Use `DurableClock.sleep` for the timeout.
- ❌ The router does not manipulate `clockWakeups` rows or
  `fireDueWorkflowClocks` directly.
- ❌ The router does not decode the matched-row payload against a call-site
  schema. Decode lives in `wait_for`.
- ❌ No DSL extensions: OR (in one subscription), NOT, ranges, lambdas,
  contains, defaulted path traversal.
- ❌ No `Effect.sleep` polling in the router. The `waitForActivityClaim`
  helper at `engine-runtime.ts:69-82` is a fencing exception, not a pattern
  to reuse.
- ❌ No `DurableTable` fenced-claim or compare-and-set widening.
- ❌ No new `as Effect.Effect<...>` / `as unknown as Effect.Effect<...>` casts.
- ❌ No `Date.now()`. Use `Clock.currentTimeMillis`.
- ❌ No `if` / `switch` on outcome `_tag`. Use `Match.tag`.
- ❌ No `paused` status. v0 enum = active / completed / timed_out / retired.
- ❌ Wait/completion table stays under `@firegrid/runtime`. Do not add it to
  `@firegrid/protocol`.
- ❌ No separator-encoded composite keys. Use `Schema.transformOrFail` to a
  JSON tuple, matching `packages/protocol/src/launch/table.ts`.
- ❌ No test-only state-store facade. Inspect rows through the production
  `DurableToolsTable` declaration.

## ACID Coverage Inventory

This handoff covers every ACID in `firegrid-durable-tools.feature.yaml`:

- **WAIT_FOR**: 1 (API), 2 (deterministic key), 3 (call-site decode of raw
  payload), 4 (match vs timeout), 5 (runtime-only surface), 6 (resolve once),
  7 (completion-row authoritative + recovery).
- **SUBSCRIPTION**: 1 (single code path), 2 (no two-step), 3 (raw payload),
  4 (DSL shape), 5 (OR = multiple subscriptions), 6 (no extensions),
  7 (scoped worker).
- **TIMEOUT**: 1 (DurableClock), 2 (typed timeout exit), 3 (preemption),
  4 (no-op on late fire).
- **LIFECYCLE**: 1 (enum), 2 (re-check), 3 (retired blocks dispatch),
  4 (no fiber registry), 5 (source-fiber leak tolerated).
- **RUNTIME_BOUNDARY**: 1 (once-per-host Layer), 2 (runtime-private table),
  3 (typed-facade registry), 4 (host composition).
- **PUBLIC_SURFACE**: 1 (no start), 2 (no executeByName), 3 (no DSL ext),
  4 (no sleep facade), 5 (no client surface).
- **BOUNDARIES**: 1 (protocol/durable-streams), 2 (no new package),
  3 (no polling), 4 (claim path isolated), 5 (no operator revival),
  6 (transformOrFail), 7 (no raw appends), 8 (no fenced-claim),
  9 (no duplicate declarations).
- **EFFECT_IDIOMS**: 1 (it.effect), 2 (Clock.currentTimeMillis),
  3 (Match.tag), 4 (no casts), 5 (production declaration in tests).

If a future requirement appears that this handoff does not cover, update the
spec **first**, then this handoff. Do not extend the implementation without
spec backing.

## Escalation

Escalate to coordinator (do not deviate silently) if:

- `Effect.race` of `DurableDeferred.await` and `DurableClock.sleep` needs
  internal `@effect/workflow` plumbing not currently exposed.
- A real product call site needs a trigger predicate that `fieldEquals` does
  not express. Cite the call site; do not silently extend the DSL.
- The engine's `deferredDone` idempotency assumption (`existingDeferred` is
  `None`) is found to be insufficient for the recovery loop.
- The wait/completion table needs a browser/client schema declaration. The
  current rule is runtime-private; a cross-boundary need must be documented
  before the schema migrates to `@firegrid/protocol`.
