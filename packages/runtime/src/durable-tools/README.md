# `@firegrid/runtime/durable-tools`

Durable tools for `@effect/workflow` handlers running on the Firegrid
substrate. v0 ships one primitive: **`wait_for`** — a workflow-handler API
that durably suspends until a matching row appears in a registered
DurableTable source collection, with an optional timeout.

> Spec: [`features/firegrid/firegrid-durable-tools.feature.yaml`](../../../../../features/firegrid/firegrid-durable-tools.feature.yaml)
> SDD:  [`docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md`](../../../../../docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md)
> Handoff: [`docs/handoffs/2026-05-13-durable-tools-wait-for-pr1-handoff.md`](../../../../../docs/handoffs/2026-05-13-durable-tools-wait-for-pr1-handoff.md)

---

## TL;DR

```ts
import { WaitFor, type WaitForOutcome } from "@firegrid/runtime/durable-tools"
import { Effect, Match, Schema } from "effect"

const ResultRow = Schema.Struct({
  requestId: Schema.String,
  status: Schema.String,
  text: Schema.String,
})

// Inside any @effect/workflow workflow handler:
const outcome = yield* WaitFor.match({
  name: "approval",                                  // unique within this execution
  source: "flamecast.turns",                         // registered source-collection name
  trigger: [{ path: ["requestId"], equals: "req-123" }],
  resultSchema: ResultRow,                           // decode at the call site
  timeoutMs: 30_000,                                 // optional
})

return Match.value(outcome).pipe(
  Match.tag("Match",   ({ row }) => `got "${row.text}"`),
  Match.tag("Timeout", () => "gave up"),
  Match.exhaustive,
)
```

`wait_for` writes a durable wait row, suspends the workflow on a
`DurableDeferred`, and resumes when the wait router observes a
matching row in your source collection. With `timeoutMs`, the suspension
races against `DurableClock.sleep`.

---

## What's in the box

| Export | Purpose |
|---|---|
| `WaitFor.match<A>(options)` | The workflow-handler API. Returns `Effect<WaitForOutcome<A>, ...>`. |
| `WaitForOutcome<A>` | `{ _tag: "Match"; row: A } \| { _tag: "Timeout" }`. |
| `WaitForOptions<A>` | `{ name, source, trigger, resultSchema?, timeoutMs? }`. |
| `WaitForError` | Tagged error for table / decode failures from inside `WaitFor.match`. |
| `FieldEqualsTrigger` / `FieldEqualsPredicateSchema` / `FieldEqualsTriggerSchema` | The trigger DSL: AND of `{ path, equals }` predicates over decoded row fields. |
| `evaluateFieldEquals(trigger, row)` | Pure evaluator; exported so consumers can predicate-test rows themselves. |
| `WaitStatus` / `WaitStatusSchema` | `"active" \| "completed" \| "timed_out" \| "retired"`. |
| `WaitOutcomeKind` / `WaitOutcomeKindSchema` | `"match" \| "timeout"`. |
| `WaitKey` / `WaitKeySchema` / `WaitKeyEncoded` | Composite key `{ executionId, name }`, encoded as a strict JSON tuple via `Schema.transformOrFail`. |
| `WaitRow` / `WaitCompletionRow` | Row types for the runtime-private `DurableToolsTable`. |
| `DurableToolsTable` / `DurableToolsTableService` / `DurableToolsTableOptions` | The DurableTable declaration. Most callers do not need this — the public `DurableToolsWaitForLive` Layer provides it. |
| `SourceCollections` (`Context.Tag`) / `SourceCollectionsService` | The source-collection registry service tag. |
| `SourceCollectionHandle` | What you register. Has `{ name, subscribe: () => Stream<unknown, DurableTableError> }`. |
| `sourceCollectionStreamHandle(name, stream)` | Helper that builds a handle from a row observation `Stream`. |
| `DurableToolsWaitForLive({ streamUrl })` | The composite Layer to install once per runtime host. |
| `DurableToolsWaitForLayerOptions` | The layer options type (`= DurableToolsTableOptions`). |

---

## How the pieces fit

```
┌─────────────────────────────────────────────────────────────────┐
│  Workflow handler                                               │
│  ─────────────                                                  │
│  yield* WaitFor.match({ name, source, trigger, resultSchema })  │
│    │                                                            │
│    │ 1. Upsert wait row (waits collection)                      │
│    │ 2. Await DurableDeferred("wait-for/<name>") on the engine  │
│    │    (timeoutMs uses DurableDeferred.raceAll with            │
│    │    DurableClock.sleep)                                     │
│    │ 3. Decode the raw payload through `resultSchema`           │
│    ▼                                                            │
└─────────────────────────────────────────────────────────────────┘
        ▲                                  │
        │ engine.deferredDone              │ waits.subscribeChanges
        │ (raw payload)                    │ (includeInitialState: true)
        │                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Wait router (DurableToolsWaitForLive scope)                    │
│  ─────────────────                                              │
│   ┌──── reconcileCompletions on startup ────┐                   │
│   │ idempotent deferredDone for orphans     │                   │
│   └──────────────────────────────────────────┘                  │
│                                                                 │
│   waits.subscribeChanges(includeInitialState: true)             │
│        for each active wait (deduped by waitKey):               │
│          handle = yield* SourceCollections.awaitHandle(name)    │
│          handle.subscribe()  ── source's subscribeChanges with  │
│            (initial state + live changes, single code path)     │
│          on row:                                                │
│            re-read wait; skip if not active                     │
│            check completions; skip if timeout already won       │
│            evaluate fieldEquals trigger                         │
│            upsert completion row { outcome:"match", row }       │
│            upsert wait row { status:"completed" }               │
│            engine.deferredDone(raw row payload)                 │
└─────────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │                                  │
┌───────┴────────────┐         ┌───────────┴─────────────────────┐
│ DurableToolsTable  │         │ SourceCollections registry      │
│ ────────────────   │         │ ───────────────────             │
│  waits             │         │  register(handle)               │
│  completions       │         │  awaitHandle(name) ── per-name  │
│  (firegrid.        │         │    Deferred so waits don't      │
│   durableTools)    │         │    race the registration        │
└────────────────────┘         └─────────────────────────────────┘
```

---

## Setup

`wait_for` requires three things in scope:

1. A **`@effect/workflow` `WorkflowEngine`** — typically from
   `DurableStreamsWorkflowEngine.layer({ streamUrl })`.
2. **`DurableToolsWaitForLive({ streamUrl })`** — provides
   `DurableToolsTable`, `SourceCollections`, and the router (a scoped fiber
   that lives in the layer scope).
3. At least one **source collection** registered with `SourceCollections`
   before the workflow runs (or registered later — the router blocks on
   `awaitHandle` so late registration still works, but earlier is simpler).

### Minimal example

```ts
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  DurableToolsWaitForLive,
  SourceCollections,
  WaitFor,
  sourceCollectionStreamHandle,
} from "@firegrid/runtime/durable-tools"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Schema } from "effect"
import { Workflow } from "@effect/workflow"

// 1. A product source. Any DurableTable collection works.
const TurnSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  requestId: Schema.String,
  status: Schema.String,
})
class TurnsTable extends DurableTable("flamecast.turns", { rows: TurnSchema }) {}

// 2. A workflow that calls wait_for.
const ApprovalWorkflow = Workflow.make({
  name: "approval-workflow",
  payload: Schema.Struct({ id: Schema.String, requestId: Schema.String }),
  success: Schema.String,
  idempotencyKey: (p) => p.id,
})

const workflowLayer = ApprovalWorkflow.toLayer((payload) =>
  Effect.gen(function*() {
    const outcome = yield* WaitFor.match({
      name: "approval",
      source: "flamecast.turns",
      trigger: [
        { path: ["requestId"], equals: payload.requestId },
        { path: ["status"], equals: "submitted" },
      ],
      resultSchema: TurnSchema,
      timeoutMs: 60_000,
    }).pipe(Effect.orDie)            // domain errors as workflow defects

    return outcome._tag === "Match" ? outcome.row.id : "timeout"
  }))

// 3. Compose layers + register the source.
const runtime = workflowLayer.pipe(
  Layer.provideMerge(DurableToolsWaitForLive({
    streamUrl: `${BASE_URL}/v1/stream/firegrid.durableTools`,
  })),
  Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
    streamUrl: `${BASE_URL}/v1/stream/firegrid.workflow`,
  })),
  Layer.provideMerge(TurnsTable.layer({
    streamOptions: {
      url: `${BASE_URL}/v1/stream/flamecast.turns`,
      contentType: "application/json",
    },
  })),
)

const registerSource = Effect.gen(function*() {
  const sources = yield* SourceCollections
  const table = yield* TurnsTable
  yield* sources.register(
    sourceCollectionStreamHandle("flamecast.turns", table.rows.rows()),
  )
})

// 4. Run.
await Effect.runPromise(Effect.scoped(
  Effect.gen(function*() {
    yield* registerSource
    return yield* ApprovalWorkflow.execute({
      id: "approval-1",
      requestId: "req-123",
    })
  }).pipe(Effect.provide(runtime)),
))
```

---

## Patterns

### Single match, no timeout

Simplest path — workflow suspends on a single `DurableDeferred` until the
router observes a matching row.

```ts
const outcome = yield* WaitFor.match({
  name: "settle",
  source: "payments.events",
  trigger: [{ path: ["paymentId"], equals: "pmt-42" }],
  resultSchema: PaymentEvent,
})
// outcome._tag === "Match" — `outcome.row` is the decoded PaymentEvent.
```

### Match with timeout

`timeoutMs` races the match deferred against a `DurableClock.sleep`. The
losing branch is interrupted; the wait row's status reflects the winner
(`"completed"` or `"timed_out"`).

```ts
const outcome = yield* WaitFor.match({
  name: "external-callback",
  source: "providers.callbacks",
  trigger: [{ path: ["requestId"], equals: requestId }],
  resultSchema: CallbackResult,
  timeoutMs: 30_000,
})

return Match.value(outcome).pipe(
  Match.tag("Match",   ({ row }) => handleResult(row)),
  Match.tag("Timeout", () => handleTimeout()),
  Match.exhaustive,
)
```

### Tagged-union row payloads

Decoding at the call site means a `Schema.Union` works without router
involvement.

```ts
const Result = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Succeeded"),
    requestId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    requestId: Schema.String,
    reason: Schema.String,
  }),
)

const outcome = yield* WaitFor.match({
  name: "provider-result",
  source: "providers.results",
  trigger: [{ path: ["requestId"], equals: requestId }],
  resultSchema: Result,
})

if (outcome._tag !== "Match") return "Timeout"
return Match.value(outcome.row).pipe(
  Match.tag("Succeeded", ({ text }) => `ok: ${text}`),
  Match.tag("Failed",    ({ reason }) => `fail: ${reason}`),
  Match.exhaustive,
)
```

### OR triggers

The DSL is intentionally AND-only inside one subscription. Express OR by
running multiple `wait_for` calls and racing them with
`DurableDeferred.raceAll`, or by issuing parallel waits whose first
completion you want.

```ts
// Wait until *either* an approved or rejected event arrives.
const outcome = yield* DurableDeferred.raceAll({
  name: "approve-or-reject",
  success: ResultSchema,
  error: Schema.Never,
  effects: [
    WaitFor.match({ name: "approved", source: "decisions", trigger: [{ path: ["kind"], equals: "approved" }] }),
    WaitFor.match({ name: "rejected", source: "decisions", trigger: [{ path: ["kind"], equals: "rejected" }] }),
  ],
})
```

### Cancelling / retiring a wait

Flip the wait row's status to `"retired"` (or anything other than
`"active"`). The router's per-dispatch re-check skips dispatches against
non-active waits, so subsequent matching rows produce no completion. This
strands the awaiting workflow; pair it with a separate event the handler
also awaits if you want graceful cancellation.

```ts
const table = yield* DurableToolsTable
const all = yield* table.waits.query((coll) => coll.toArray)
const wait = all.find((w) => w.waitKey.name === "approval")
if (wait !== undefined) {
  yield* table.waits.upsert({ ...wait, status: "retired" })
}
```

> The `.get` facade on `DurableTable` is currently unreliable for composite
> keys (see Gaps); `.query` + filter is the safe path.

---

## Source-collection contract

The router only knows about `SourceCollectionHandle`. The helper
`sourceCollectionStreamHandle(name, stream)` wraps a row observation `Stream`
into a handle whose `subscribe()` returns the same stream shape used by
`DurableTable` collection `rows()`. No snapshot-then-subscribe; no per-call
layer acquisition.

The registry is rendezvous-style: `awaitHandle(name)` suspends until
`register(handle)` lands. This means:

- **You can register before or after starting workflows that wait on a
  source.** Late registration is supported by design.
- A per-wait fiber is held in the router's scope while waiting for its
  source. Cost is one suspended fiber per unattached wait — negligible.

To register a non-DurableTable source (e.g., a raw Effect Stream), you can
build a handle manually — only the `subscribe()` and `name` fields are
required:

```ts
const customHandle: SourceCollectionHandle = {
  name: "my.custom.source",
  subscribe: () => myStream,   // Stream<unknown, DurableTableError>
}
yield* sources.register(customHandle)
```

> Heads-up: rolling your own handle bypasses `DurableTable`'s
> `decodeRowForRead`, so make sure the emitted values are already decoded
> objects in the same shape your trigger DSL expects.

---

## Trigger DSL: capabilities and limits

The trigger is an AND of scalar field-equality predicates:

```ts
type FieldEqualsTrigger = ReadonlyArray<{
  readonly path: ReadonlyArray<string>
  readonly equals: string | number | boolean
}>
```

| You want to express... | How |
|---|---|
| `row.status === "submitted"` | `[{ path: ["status"], equals: "submitted" }]` |
| `row.payload.requestId === "abc" && row.status === "submitted"` | `[{ path: ["payload", "requestId"], equals: "abc" }, { path: ["status"], equals: "submitted" }]` |
| OR | Multiple `wait_for` calls; race them. |
| NOT / range / array contains / lambdas | **Not supported** in v0 (PUBLIC_SURFACE.3). |
| Defaulted path traversal (`a?.b ?? "x"`) | **Not supported.** A missing segment makes the whole predicate false. |

Triggers are validated at call time against `FieldEqualsTriggerSchema`
(via `Schema.decodeUnknown`), so a malformed trigger fails the
`WaitFor.match` call with a `ParseError` rather than silently degrading.

The pure evaluator is exported as `evaluateFieldEquals(trigger, row)` if
you want to predicate-test rows yourself in product code.

---

## Crash semantics

The **wait completion row is authoritative.** On scope acquisition, the
wait router runs a reconciler pass over `completions` rows:

1. If a `match` completion exists for a wait that's still in `"active"`
   status, the reconciler flips it to `"completed"` and calls
   `engine.deferredDone` with the persisted payload.
2. If the wait is already `"completed"`, the reconciler still issues
   `engine.deferredDone` — the engine's `Option.isNone` guard makes it a
   no-op if the deferred row already exists.

This bridges two distinct crash gaps:

- **Gap A**: completion row written → crash → wait row still `"active"`.
  Reconciler observes the orphan and bridges.
- **Gap B**: wait row flipped to `"completed"` → crash before
  `engine.deferredDone` → workflow stranded. Reconciler issues the call.

Timeout completions don't need a router-side bridge: the workflow body's
own `DurableClock.sleep` is durable, so on replay the race deferred
captures the Timeout marker without help from the router.

> One workflow body / one race deferred / two completion paths. Exactly
> one resolves the workflow because `engine.deferredDone` is idempotent
> per `(executionId, deferredName)`.

---

## Layer composition rules

- **Acquire `DurableToolsWaitForLive` once per runtime-host scope.** The
  router fork lives in that scope and shuts down on scope close.
  Recreating the layer per workflow execution defeats the dedup/reconcile
  guarantees.
- **Provide `WorkflowEngine` alongside.** `wait_for` requires it; the
  composite layer does *not* include a workflow-engine layer because
  consumers typically configure their own (different stream URL, worker
  id, etc.).
- **Register sources before — or during — workflow execution.** Late
  registration works via `awaitHandle`, but starting workflows that wait
  on a source that's never registered will leave per-wait fibers
  suspended indefinitely.
- **Use a workflow engine that owns `scheduleClock`.** Timeouts use
  `DurableClock.sleep`; the Durable Streams workflow engine persists and
  fires wakeups through its `WorkflowEngine.scheduleClock` implementation.

---

## Workflow handler ergonomics

`WaitFor.match` lives at the boundary between `@effect/workflow` and
application code. Its error channel includes:

- `WaitForError` — table read/write or trigger-validation failures.
- `ParseResult.ParseError` — `resultSchema` decode failures on resume.
- `DurableTableError` — surfaced from the underlying DurableTable service.

Workflows declared with `error: Schema.Never` need to either:

1. Declare a richer `error` schema on the `Workflow.make(...)` so these
   error types remain in the workflow signature, **or**
2. Treat them as defects with `Effect.orDie`. This matches the existing
   workflow-engine activity pattern.

```ts
yield* WaitFor.match({ ... }).pipe(Effect.orDie)
```

---

## Internals

The package is small and self-contained:

```text
durable-tools/
  DurableToolsWaitFor.ts       # public Layer: table + sources + router
  index.ts                     # curated re-exports
  internal/
    keys.ts                    # WaitKey: Schema.transformOrFail to JSON tuple
    table.ts                   # DurableToolsTable + findWaitByKey query helper
    types.ts                   # FieldEqualsTrigger DSL + evaluator,
                               # WaitStatus, WaitForOutcome, WaitForError
    source-collections.ts      # SourceCollections registry with per-name
                               # Deferred rendezvous (awaitHandle)
    wait-for.ts                # WaitFor.match: persist wait, await
                               # DurableDeferred (optionally raced against
                               # DurableClock.sleep), call-site decode
    wait-router.ts             # scoped subscriber driver forked by the Layer
    reconcile.ts               # crash-recovery loop run at acquire
```

Module dependency tree (within the package):

```
DurableToolsWaitFor ─── wait-router ─── reconcile
                              │                    │
                              ├── source-collections │
                              └── table ────────────┘
                                    │
                                    └── types, keys

wait-for ── table, types, keys
       └── (consumed inside workflow handlers; not a layer dep)
```

There are no cross-package edits required to use `wait_for`. In
particular, **`@firegrid/protocol` is not extended**; the wait/completion
table is intentionally runtime-private until a browser/edge surface is
proven to need the same row contract.

---

## Gaps & tradeoffs (known limitations)

These are documented for transparency; none should block product use of
`wait_for` for v0 single-host workflows.

### 1. `DurableTableCollectionFacade.get` misses composite-key rows

In the current `effect-durable-operators` + Effect Schema versions, the
`.get` facade does not return rows whose primary key was declared via
`Schema.transformOrFail` (the index lookup mismatches the upserted key,
even though `.query.toArray` returns the row correctly).

**Workaround**: `internal/table.ts` exports `findWaitByKey(table,
waitKey)` which uses a `.query.toArray.find(...)` scan. The router,
reconciler, and `wait_for` all route lookups through this helper. The
scan is O(active waits) — acceptable for v0, since waits are short-lived.

**Future**: fix the upstream `.get` path in `effect-durable-operators` and
delete `findWaitByKey`. The follow-up should also revisit any other
composite-keyed table in the repo (e.g., `RuntimeOutputTable`).

### 2. Match vs. timeout race window

When a matching source row arrives within the same tick as the durable
clock firing, both the router (match path) and the workflow body's
timeout side can observe an `active` wait status simultaneously. The
implementation narrows the window with a pre-write completion-row check
in both paths, but it does not fully eliminate it — a strict
"first-completion-wins" ordering on the completion row would require an
atomic insert-if-absent on `DurableTable`, which the spec
(`BOUNDARIES.8`) intentionally does not add yet.

**Today's guarantee**: the *workflow* outcome is unambiguous — whichever
side calls `engine.deferredDone` first wins, because the engine's
`deferredDone` is idempotent per `(executionId, deferredName)`. The
completion row may briefly disagree with the workflow's actual exit in
the narrow race window, but recovery is unaffected.

**Future**: if a product surface needs "first completion row wins"
strictly, add a fenced/CAS insert path to `DurableTable` (currently
forbidden by `firegrid-durable-tools.BOUNDARIES.8`) and route both sides
through it.

### 3. The runtime host doesn't auto-wire `DurableToolsWaitForLive` yet

`FiregridRuntimeHostLive` does not include the workflow engine or the
durable-tools layer today. Consumers must compose
`DurableToolsWaitForLive({ streamUrl })` themselves at their composition
root, alongside their `WorkflowEngine` layer.

**Future**: once the runtime host gains workflow-engine integration, the
durable-tools layer should be composed there too. Tracked by
`firegrid-durable-tools.RUNTIME_BOUNDARY.4` (which currently carries a
`-note` describing this gap).

### 4. Source registration with `any` casts inside the registry

The internal `Map` value type uses concrete handles. If you register the
same name twice, the second registration is silently ignored (the
existing entry's `Deferred` was already resolved). Currently there's no
"replace handle" path, by design — registering the same source twice is
likely a bug, and the silent-no-op is the more defensible default.

**Future**: if hot-swapping sources becomes a requirement, the registry
needs an explicit `replace(handle)` path with a SubscriptionRef so
already-attached fibers can pick up the new handle.

### 5. Tests use async-`it` + `Effect.runPromise`, not `it.effect`

`@effect/vitest` is not currently a runtime dependency. Adding it pulled
in a newer `effect` version that broke pre-existing workflow-engine
types. Spec `EFFECT_IDIOMS.1` was reworded to accept either harness; the
`Effect.runSync` prohibition is retained.

**Future**: when `effect` is bumped repo-wide, add `@effect/vitest` to
`@firegrid/runtime` and migrate `WaitFor.test.ts` to `it.effect`.

### 6. One narrow `eslint-disable no-unsafe-return` in `wait-for.ts`

`DurableDeferred.raceAll`'s type surface in `@effect/workflow` produces
an `any` in its requirements channel through a generic-inference quirk
on its array-tuple parameter. The declared return type of `matchImpl` is
precise; the suppression avoids an `as Effect.Effect<...>` cast that the
spec forbids (`BOUNDARIES.4`).

**Future**: fix the upstream `raceAll` typing or wrap `raceAll` in a
narrow internal helper with a hand-written type.

### 7. v0 is single-host

Multi-worker safety for `wait_for` itself is not a concern — wait
dispatch idempotency comes from deterministic wait keys and the
per-dispatch re-check, both of which are race-safe for multi-worker. But
the broader durable-tools roadmap (`spawn`, `execute`) does require
fenced claims, which v0 explicitly defers (see SDD §Tool Matrix).

---

## How to expand

### Adding another tool (`schedule_me`, `spawn`, etc.)

The SDD's §Tool Matrix sketches what's next. New tools should follow the
same shape:

1. **Spec first.** Amend
   `features/firegrid/firegrid-durable-tools.feature.yaml` with the new
   tool's ACIDs under a new component (`SCHEDULE_ME`, `SPAWN`, …).
2. **Reuse the existing primitives.** A new tool should consume the
   `DurableToolsTable`, the source registry, and the workflow engine's
   deferred plumbing — not introduce a parallel substrate.
3. **Add row families to `internal/table.ts`** if needed. Keep the table
   namespace `"firegrid.durableTools"` so consumers get one stream URL,
   one preload, one materialized view.
4. **Extend the router** to handle the new row family. If the new tool
   doesn't fit the "subscribe → completeMatch" loop (e.g., a timer that
   should fire on a deadline), prefer extending `reconcile.ts` and adding
   a separate scoped worker rather than overloading
   `wait-router.ts`.
5. **Avoid pitfalls from §Gaps**: don't add fenced/CAS to `DurableTable`,
   don't reintroduce deleted operator types (`DurableConsumer`,
   `ConsumerSource`, `ConsumerCheckpointStore`, `DurableProjection`),
   don't expose `executeByName` from the workflow engine.

### Extending the trigger DSL

The bar is the same one PR 1 used: cite a real product call site that
needs the new predicate. Extensions land on
`FieldEqualsPredicateSchema` (or a new tagged predicate type), the
`evaluateFieldEquals` function, and `SUBSCRIPTION.4–6` in the spec.

Don't add predicate combinators speculatively — OR is already expressible
as multiple subscriptions, and the lack of NOT / range / lambdas keeps
the DSL serializable, replay-safe, and reasonable to evaluate inside
TanStack-DB collection subscribers.

### Adding a new source type

Any `DurableTableCollectionFacade<Row, Key>` can expose its observation stream
through `sourceCollectionStreamHandle(name, facade.rows())`. For non-DurableTable
sources (e.g., raw Durable Streams or external event sources), build a handle
manually — only `{ name, subscribe }` is required. The `subscribe()` stream must
emit decoded row values; the router does not decode.

### Migration path to it.effect

When `effect` is bumped repo-wide:

1. Add `@effect/vitest` to `packages/runtime/devDependencies`.
2. Migrate `WaitFor.test.ts` to `it.effect("...", () => Effect.gen(...))`,
   replacing the `runWith` harness with a per-test `Effect.scoped` +
   `Effect.provide(layer)` pattern.
3. Update spec `EFFECT_IDIOMS.1` to remove the async-`it` fallback (mark
   as deprecated; don't renumber).

### Wiring into the runtime host

Once `FiregridRuntimeHostLive` (in `runtime-host/`) gains a workflow
engine layer, compose `DurableToolsWaitForLive` there too, derive its
`streamUrl` from `${durableStreamsBaseUrl}/v1/stream/${namespace}.durableTools`,
and update spec `RUNTIME_BOUNDARY.4` to drop the `-note`.

---

## Hard rejects (do not undo)

These are encoded in the spec and were upheld through review:

- No new top-level package — `wait_for` lives under `@firegrid/runtime`.
- No `@durable-streams/*` imports in `@firegrid/protocol`.
- No revival of `DurableConsumer` / `ConsumerSource` /
  `ConsumerCheckpointStore` / `DurableProjection` under new names.
- No public `executeByName` / `WorkflowDispatchService` / workflow-name
  registry. `wait_for` resolves an *already-running* workflow's deferred,
  not start a new execution.
- No snapshot-then-subscribe. Sources use
  `subscribeChanges(..., { includeInitialState: true })`.
- No separate `subscriptions` collection. v0 = `waits` + `completions`.
- No `ToolTimersTable`. Timeouts use `DurableClock.sleep`.
- No router-side decoding through a call-site schema — payloads flow
  raw; decoding happens in `WaitFor.match`.
- No DSL extensions: OR (inside one subscription), NOT, range, lambdas,
  contains, defaulted path traversal.
- No `Effect.sleep` polling in the router; the activity-claim
  `waitForActivityClaim` helper is not a pattern to reuse.
- No `DurableTable` fenced-claim or compare-and-set widening.
- No new `as Effect.Effect<...>` / `as unknown as Effect.Effect<...>`
  casts. Narrow `eslint-disable` is acceptable for upstream-typing
  workarounds; type casts are not.
- No `Date.now()` — use `Clock.currentTimeMillis`.
- No `paused` wait status. v0 enum is
  `active` / `completed` / `timed_out` / `retired`.
- The wait/completion table stays runtime-private. Don't add it to
  `@firegrid/protocol`.
- No separator-encoded composite keys. New composite keys use
  `Schema.transformOrFail` to JSON tuples (mirroring
  `packages/protocol/src/launch/table.ts`).

If you find yourself needing to relax any of these, **update the spec
first** (`features/firegrid/firegrid-durable-tools.feature.yaml`), get
coordinator review, and only then change code.
