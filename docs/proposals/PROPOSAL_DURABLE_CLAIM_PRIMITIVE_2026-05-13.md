# Proposal: Durable Concurrency Primitives Backed by `DurableTable`

**Date:** 2026-05-13
**Status:** Narrowed proposal (no implementation yet).
**Author:** OLA (durable-tools `wait_for` implementation feedback +
coordinator review).
**Related:**
- [`SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md`](./SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md) —
  supersedes the context-ownership path that originally required
  `DurableKeyedMutex<contextId>`.
- [`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`](./SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md) —
  historical context; do not implement its `DurableKeyedMutex<contextId>`
  direction while the workflow-driven runtime proposal is active.
- [`firegrid-durable-tools.feature.yaml`](../../features/firegrid/firegrid-durable-tools.feature.yaml) — `BOUNDARIES.8`
  currently forbids the fenced primitive these designs assume; this
  proposal recommends amending it.
- Effect upstream:
  [`Semaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Semaphore.ts).

## Summary

Implement the one durable concurrency primitive that still has concrete
day-one pressure after the workflow-driven runtime proposal:
`DurableClaim<K>`, backed by the Firegrid durable substrate (`DurableTable`
for state, a Durable Streams server-side conditional append for the
cross-host fence).

The current proposal intentionally does **not** include durable semaphore
variants. A `DurableSemaphore` or `DurablePartitionedSemaphore` may be
useful later for cluster-wide budgets or fairness, but neither has a
day-one product call site. They should be proposed when a real consumer
defines the required capacity/fairness semantics.

One primitive:

**`DurableClaim<K>`** — **write-once, never-released**
claim-before-side-effect checkpoint. The AtMostOnce pattern that
scope-bound locks intentionally don't provide.

`DurableKeyedMutex<K>` is deliberately removed from this proposal. The
workflow-driven runtime SDD replaces its original context-ownership use case
with `RuntimeContextWorkflow(contextId)` and the `runRuntimeContext` activity
claim. Reintroduce a keyed mutex only if a future non-workflow, release-on-exit
resource owner has a concrete product call site.

Narrowed day-one customer:

- Runtime ingress stdin delivery (AtMostOnce checkpoint).

Workflow activity claims still need hardening, but the workflow-driven runtime
SDD treats that as workflow-engine-internal work first. It may reuse
`DurableClaim` later if the primitive proves to be the right implementation
boundary.

## Why these are not semaphores

Effect's `Semaphore` and `PartitionedSemaphore` are capacity/fairness
primitives. The codebase's current durable stdin-delivery need is different:

- `DurableClaim<K>` is a permanent claim-before-side-effect checkpoint.

That lifecycle is not modeled by `Semaphore` without misleading readers.
Picking a misleading name for a write-once checkpoint is the exact mistake
that landed `DurableConsumer` and friends.

If product pressure later requires a cluster-wide process budget or
cross-workflow fair sharing, that should be a separate proposal with
concrete call sites. Plain in-memory `Semaphore` remains correct for
per-host process budgets.

## The primitives

### `DurableClaim<K>` (new primitive — write-once, no release)

```ts
export interface DurableClaim<K> {
  /**
   * Claim-before-side-effect with AtMostOnce semantics.
   *
   * Lifecycle:
   * - Attempts a server-side conditional insert of a claim row keyed by
   *   `K`, carrying this caller's `holderId`. The insert is rejected
   *   server-side if a claim row for the same key already exists
   *   (this is the cross-host fence — see "Substrate fence" below).
   * - On `Acquired`: runs `effect` and returns `Option.some(result)`.
   *   **The claim row is NOT released on success, failure, or
   *   interruption.** Restart with the same key observes the existing
   *   claim and returns `Option.none` again. This is the durable
   *   AtMostOnce checkpoint guarantee — the side effect is performed at
   *   most once across the lifetime of the claim row.
   * - On `Lost`: returns `Option.none` without running `effect`.
   *
   * Explicit retirement is a separate operation
   * (`retire(key, evidence)`) and requires durable retirement evidence
   * — never automatic on body failure.
   */
  readonly withClaim: <A, E, R>(
    key: K,
    holderId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | DurableClaimError, R>

  /**
   * Pure check: returns the current claim row for this key without
   * attempting to acquire. Useful for replay-time dispatching where
   * the caller wants to know which holder won, not to compete.
   */
  readonly inspect: (
    key: K,
  ) => Effect.Effect<Option.Option<ClaimRow<K>>, DurableClaimError>

  /**
   * Retire a claim row by writing a retirement-evidence row keyed by
   * the same `K`. Requires the caller to produce the
   * `RetirementEvidence` value, which is opaque to this primitive — the
   * intent is that retirement is driven by application-level policy
   * (e.g. the workflow recorded a terminal exit elsewhere), not
   * automatically by the primitive.
   */
  readonly retire: (
    key: K,
    evidence: RetirementEvidence,
  ) => Effect.Effect<void, DurableClaimError>
}

export const DurableClaim: {
  readonly make: <K>(options: {
    readonly streamUrl: string
    readonly contentType?: string
    readonly keySchema: Schema.Schema<K, string>
  }) => Effect.Effect<DurableClaim<K>, DurableTableError, Scope.Scope>
}
```

This is **not** a mutex. There is no waiter queue, no `withLock` scope,
and no release-on-exit. The contract is "first writer wins forever, until
explicit retirement evidence lands."

**Use cases:**

- *Runtime ingress stdin delivery (AtMostOnce checkpoint).* Today this is
  an inline `get`-then-`upsert` on `RuntimeIngressTable.deliveries` at
  `packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`.
  The claim row must persist across process death so restart skips the
  same `(subscriberId, inputId)` — this is the AtMostOnce semantic the
  test suite intentionally verifies (`firegrid-agent-ingress.DELIVERY.3`).
- *Workflow activity claims.* Today this is a raw
  `DurableStream.producer.append` path at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:42-105`.
  Different workers race; one wins; the winner runs the activity body
  and writes the result. The claim row is never released; on replay, the
  existing claim plus the activity result short-circuit re-execution.
- *(Future)* `execute(sandbox, input)` durable tool in
  `firegrid-durable-tools` — externally visible side effects need
  claim-before-side-effect checkpointing.

### Decision Rule

Use `DurableClaim<K>` only for write-once, never-released
claim-before-side-effect checkpoints. Do not use it for scope-bound ownership
where a failed or completed body should release the resource. That
release-on-exit problem is intentionally outside this narrowed proposal.

Examples:

- *AtMostOnce stdin delivery.* Bytes are written-once. Even if the
  delivery body crashes mid-way, restart must NOT retry. ->
  `DurableClaim`.
- *Activity claim.* Whoever wins the race owns the result row forever.
  This may later consume `DurableClaim`, but the workflow-driven runtime
  SDD treats activity-claim hardening as workflow-engine-internal first.
- *Context ownership.* Do not model with `DurableClaim`; the
  workflow-driven runtime proposal uses `RuntimeContextWorkflow(contextId)`
  and activity claims instead.

## Cross-references: what these primitives replace in the codebase

### 1. Workflow activity claims → `DurableClaim<ActivityClaimKey>`

**Where:** `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:42-105`.

**What's there today:** Three functions — `appendActivityClaimInsert`,
`waitForActivityClaim`, `claimActivity` — that hand-roll fenced claim
acquisition by:

- Producing a raw `DurableStream.producer` per call with a deterministic
  `producerId` (the fence — Durable Streams rejects duplicate appends
  from the same producerId).
- Appending a State Protocol-compatible insert event by hand (`type`,
  `key`, `value`, `headers`).
- Polling `table.activityClaims.get(claimKey)` in a 10ms-interval loop up
  to 200 iterations (~2s) to wait for the materialized claim to land.

This is the **only** raw-Durable-Streams append in production runtime
code and is explicitly called out by
`firegrid-durable-tools.BOUNDARIES.4` as a path other tool authors
should NOT copy.

**Lifecycle today: write-once, never released.** The claim row is the
"this worker owns the right to run this activity attempt" record. If the
body fails, the activity row records the failure but the claim row
stays. On replay, the existing claim plus the existing result
short-circuit re-execution. This is `DurableClaim` semantics, not mutex.

**What it becomes with `DurableClaim<ActivityClaimKey>`:**

```ts
const activityKey = { executionId, activityName, attempt }
const result = yield* claim.withClaim(activityKey, workerId,
  Effect.gen(function*() {
    const activityInstance = WorkflowEngine.WorkflowInstance.initial(...)
    return yield* activity.executeEncoded.pipe(
      Workflow.intoResult,
      Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
    )
  }),
)
// result: Option<Workflow.Result>. None means another worker won the
// claim; the workflow re-attempts later and observes the existing
// claim + (eventually) result on the next replay.
```

The 10ms-poll-loop disappears (durable inspect replaces it). The raw
`DurableStream.producer` import in `engine-runtime.ts` disappears. The
"fence-via-deterministic-producerId" trick disappears — replaced by the
`DurableClaim` primitive's underlying server-side conditional append.

### 2. Runtime ingress stdin delivery checkpoint → `DurableClaim<RuntimeInputDeliveryKey>`

**Where:** `packages/runtime/src/providers/sandboxes/local-process-stdin-delivery.ts`,
specifically the `mapEffect` block beginning at line ~194 (the "claim a
delivery before emitting bytes" path).

**What's there today:** A `.get` + `if claimedAt is set skip` + `.upsert`
triple on `RuntimeIngressTable.deliveries`, keyed by
`(subscriberId, inputId)`. Single-host AtMostOnce; multi-host raced
delivery is not currently a concern, but the row shape is already
prepared for it.

**Lifecycle today: write-once, never released.** The claim row records
"this subscriber has claimed this logical input." If the process dies
between writing the claim and emitting the encoded bytes, restart sees
the claim row and **must skip the row** —
`firegrid-agent-ingress.DELIVERY.3` and the failure-injection test at
`local-process-stdin-delivery.test.ts:126` intentionally verify this. A
mutex with release-on-exit would break the AtMostOnce contract by
re-emitting bytes after restart. This is `DurableClaim` semantics, not
mutex.

**What it becomes with `DurableClaim<RuntimeInputDeliveryKey>`:**

```ts
yield* claim.withClaim(
  { subscriberId, inputId },
  subscriberId,
  emitBytesToStdin(row),
).pipe(
  Effect.flatMap(Option.match({
    onNone: () => Effect.void,    // Already claimed (by us on a prior run, or by another subscriber); skip.
    onSome: () => Effect.void,    // We acquired and emitted bytes.
  })),
)
```

The `.get`-then-`.upsert` race window (currently safe under single-host
by design but easy to misread) is replaced by the primitive's
server-side conditional insert. The persistent-claim semantic is
explicit in the API name instead of implicit in the row-write order.

### 3. Flamecast toy host duplicate-suppression (superseded)

The earlier version of this proposal mapped the Flamecast toy host's local
`Set<contextId>` to `DurableKeyedMutex<contextId>`. That path is superseded by
`SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md`: context execution authority
should move to `RuntimeContextWorkflow(contextId)`, and app-local host watchers
should disappear rather than gain a separate durable lock.

### 4. Wait/completion rows in `wait_for` (not a claim — for clarity)

**Where:** `packages/runtime/src/durable-tools/internal/`.

These rows are a durable rendezvous (workflow suspends on a
`DurableDeferred`, router resolves it), **not** a claim-before-side-effect
gate. They do not migrate to either primitive. Documenting this here
so future readers don't conflate the three patterns
(`DurableClaim` / durable workflow deferred / future release-on-exit ownership).

## Dispatcher SDD Status

`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md` is superseded for the
context-ownership path by `SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md`. Do
not implement its `DurableKeyedMutex<contextId>` design while the
workflow-driven runtime proposal is active. Host-presence and heartbeat ideas
may still be reused later as observability/capacity concerns, but they are no
longer a day-one concurrency primitive customer.

## Implementation precondition: substrate fence

### What the fence has to be

`DurableClaim` needs a **server-side conditional append** to be
sound under raced acquirers across hosts. The fence cannot be a
client-side "read-then-write" against `DurableTable.upsert`: two clients
with stale local views can each observe "no claim row exists" and both
then upsert successfully, producing two claim rows for the same key.
The materializer downstream can choose a winner, but downstream consumers
that have already observed the first row will have already acted on it.

The fence must reject the second writer **at the substrate level**,
before the row becomes visible to any consumer. The current production
example is the activity-claim path in `engine-runtime.ts:42-71`:

- Each activity-claim insert uses a `DurableStream.producer` with a
  deterministic `producerId` (e.g.
  `firegrid.workflow.activityClaim:<claimKey>`). The producer's idempotent
  append semantics — guaranteed by the Durable Streams server — reject
  duplicate appends from the same producerId. That rejection is the
  fence.

`DurableTable.insertIfAbsent(row)` is the Effect/Schema-typed wrapper
around that same substrate guarantee, with two specific requirements on
the underlying Durable Streams service:

1. **Server-side conditional append.** The append for an `insertIfAbsent`
   row must be addressed to a deterministic producer identity (or
   equivalent server-side dedup key) derived from the row's primary key,
   so a second writer for the same key receives a typed conflict response
   from the server. A local `.get`-then-`.upsert` is **not** an
   implementation.
2. **Conflict visibility on the wire.** The conflict response must reach
   the caller so the wrapper can return `{ inserted: false }`. A silent
   server-side drop (where the second writer's append is accepted but
   never appears in the stream) is not sufficient because the wrapper
   cannot distinguish "I won the race" from "the server quietly dropped
   me."

Production Durable Streams already supports (1) via the idempotent
producer pattern. (2) needs verification per the deployed service; the
amendment PR should include a small smoke test that confirms a duplicate
`insertIfAbsent` returns a distinguishable conflict.

### Spec amendment needed

Today, `firegrid-durable-tools.BOUNDARIES.8` reads:

> DurableTable does not grow a fenced-claim, compare-and-set, or
> insert-if-absent action to support wait_for; wait dispatch idempotency
> is provided by deterministic wait keys and the per-dispatch lifecycle
> re-check.

That bar was right for `wait_for` (which has the looser "exactly one of
match/timeout resolves via `engine.deferredDone` idempotency" guarantee).
It is **wrong for `DurableClaim`**, which needs AtMostOnce without an external idempotency oracle.

This proposal recommends **amending `BOUNDARIES.8`** to permit a
`DurableTable.insertIfAbsent(row)` action returning
`Effect<{ inserted: boolean }, DurableTableError>`. The amendment
justification: stdin delivery is the narrowed day-one customer, and the
activity-claim path demonstrates the same substrate fence already exists in
production code via raw `DurableStream.producer` workarounds.

### Implementation Path

Use the canonical substrate fence path only. `DurableClaim` should be built over `DurableTable.insertIfAbsent`, and `insertIfAbsent` must be backed by a server-side conditional append. A local `.get`-then-`.upsert` wrapper is acceptable only as an explanatory anti-pattern; it should not ship as a primitive because it creates a second semantic that tests cannot trust.

## Sequencing recommendation for the coordinator

1. **Amend `firegrid-durable-tools.BOUNDARIES.8`** as a docs-only spec
   PR. Justification: this proposal's narrowed day-one `DurableClaim`
   customer is runtime ingress stdin delivery; workflow activity claims
   remain a likely internal hardening customer after the workflow-driven
   runtime spike validates the model.
2. **Add `DurableTable.insertIfAbsent`** to `effect-durable-operators`,
   implemented over the Durable Streams idempotent-producer append. New
   spec ACID under `effect-durable-operators.TABLE.*` documenting the
   semantic: server-side conditional append, typed
   `{ inserted: boolean }` result, conflict visibility on the wire. The
   impl PR should include the smoke test confirming duplicate
   `insertIfAbsent` returns a distinguishable conflict.
3. **Implement `DurableClaim<K>`** under `effect-durable-operators`,
   initially for runtime ingress stdin delivery.
4. **Migrate runtime ingress stdin delivery** from `.get` + `.upsert` to
   `DurableClaim<RuntimeInputDeliveryKey>`.
5. **Evaluate workflow activity-claim migration separately** after the
   workflow-driven runtime spike. The activity-claim path is
   load-bearing, but it may remain workflow-engine-internal rather than
   consume a public claim primitive.

Do not implement `DurableKeyedMutex<K>` as part of this sequence. Its
original context-ownership customer is superseded by the workflow-driven
runtime proposal.

## Non-goals

- This proposal does **not** suggest a generic durable-state framework.
  Each tool keeps its typed `DurableTable` row schemas; the primitives
  are utilities, not service planes.
- This proposal does **not** unify `wait_for`'s wait/completion rows
  with claim semantics. Waits and completions are a durable rendezvous,
  not a claim-before-side-effect gate (see Cross-references #4).
- This proposal does **not** add `DurableSemaphore`,
  `DurablePartitionedSemaphore`, durable-fair queueing, durable rate
  limiting, or durable circuit-breaking. Those require separate
  proposals with concrete product call sites.
- This proposal does **not** add `DurableKeyedMutex`. The workflow-driven
  runtime proposal supersedes its original context-ownership use case.
- This proposal does **not** propose moving in-memory `Semaphore` /
  `PartitionedSemaphore` usage out of any existing call sites.
  Plain Effect primitives stay where they're correct (e.g., per-host
  process budget).

## Open questions for coordinator

1. **Amendment scope for `BOUNDARIES.8`.** Does the amendment permit
   only `insertIfAbsent`, or should it also allow `compareAndSet` /
   `casUpdate` (typed compare-and-set for row updates)? Recommendation:
   start with `insertIfAbsent` only; compare-and-set arrives if a real
   product call site needs it.
2. **Home for the new primitives.** Inside `effect-durable-operators`
   (visible to all consumers, including non-Firegrid), or inside
   `@firegrid/runtime` (runtime-private, easier to evolve)? Preference:
   `effect-durable-operators` if `DurableTable.insertIfAbsent` is public
   and the primitive is useful outside runtime; otherwise keep a runtime-private
   wrapper around `insertIfAbsent` until a second consumer appears.
3. **Should `DurableClaim` be type-compatible with any Effect primitive?**
   There's no exact match in the upstream library today. Recommendation:
   don't force compatibility; `withClaim(key, holderId, effect)` is a
   small, self-explanatory contract. Revisit if Effect adds a similar
   primitive upstream.
