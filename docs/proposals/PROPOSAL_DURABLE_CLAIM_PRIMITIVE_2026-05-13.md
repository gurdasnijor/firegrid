# Proposal: Durable Concurrency Primitives Backed by `DurableTable`

**Date:** 2026-05-13
**Status:** Proposed (no implementation yet).
**Author:** OLA (durable-tools `wait_for` implementation feedback +
coordinator review).
**Related:**
- [`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`](./SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md) — the
  primary customer of `DurableKeyedMutex` proposed here.
- [`firegrid-durable-tools.feature.yaml`](../../features/firegrid/firegrid-durable-tools.feature.yaml) — `BOUNDARIES.8`
  currently forbids the fenced primitive these designs assume; this
  proposal recommends amending it.
- Effect upstream:
  [`Semaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Semaphore.ts),
  [`PartitionedSemaphore`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/PartitionedSemaphore.ts).

## Summary

Implement durable analogs of Effect's concurrency primitives, backed by the
Firegrid durable substrate (`DurableTable` for state, a Durable Streams
server-side conditional append for the cross-host fence). The public types
are **interface-compatible** with the existing Effect primitives where the
semantics match; new primitives are introduced only where existing
interfaces don't fit.

Four primitives, in increasing order of distance from existing Effect
contracts:

1. **`DurableSemaphore`** — implements Effect's `Semaphore` interface.
   Total durable permit budget shared across all callers.
2. **`DurablePartitionedSemaphore<K>`** — implements Effect's
   `PartitionedSemaphore<K>` interface. Total durable budget, round-robin
   fair across partition keys.
3. **`DurableClaim<K>`** — new primitive. **Write-once,
   never-released** claim-before-side-effect checkpoint. The AtMostOnce
   pattern that scope-bound locks intentionally don't provide.
4. **`DurableKeyedMutex<K>`** — new primitive. Scope-bound mutual
   exclusion: one holder per key, release-on-exit. The
   mutual-exclusion-with-release pattern that survives process death only
   when paired with a separate stale-holder policy.

**The split between `DurableClaim` and `DurableKeyedMutex` is
load-bearing.** Release-on-exit mutual exclusion is *not* the same as a
persistent claim-before-side-effect checkpoint. Conflating them — using a
mutex to model AtMostOnce delivery, or using a write-once claim to model
dispatcher ownership — silently breaks the semantic each pattern relies
on. They share the same underlying fence
(`DurableTable.insertIfAbsent`) but expose different lifecycles.

Distinct customers from day one:

- **`DurableClaim<K>`** customers (write-once, no release):
  - Runtime ingress stdin delivery (AtMostOnce checkpoint).
  - Workflow activity claims.
- **`DurableKeyedMutex<K>`** customer (scope-bound release):
  - The runtime-host dispatcher
    (`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`) is the first
    declared customer. The Flamecast toy host's in-process
    `Set<contextId>` becomes redundant once the durable mutex is wired
    in.

The two primitives are designed together because they share the same
underlying fence and the same set of stream/schema concerns; they are
**not** type-compatible interchangeably.

## Why the interface compatibility matters

The interface contract is what makes the proposal land. Callers should be
able to write:

```ts
const sem: Semaphore.Semaphore = yield* DurableSemaphore.make({
  permits: 100,
  streamUrl: `${baseUrl}/v1/stream/firegrid.processBudget`,
})

yield* sem.withPermits(1)(launchRuntimeProcess(contextId))
```

…without learning new vocabulary, and without `withPermits` behavior
diverging from what a reader expects from
[`Effect.Semaphore`](https://effect.website/docs/concurrency/semaphore/).
The only thing different from the in-memory version is the backing store
and the cost profile (a write per acquire instead of an atomic counter
decrement).

When the existing Effect contract doesn't model the pattern (per-key
mutual exclusion), we name the new primitive honestly rather than warping
`PartitionedSemaphore` semantics. Picking a misleading name —
`DurablePartitionedSemaphore` for what's actually a keyed mutex — is the
exact mistake that landed `DurableConsumer` and friends.

## The primitives

### `DurableSemaphore` (Effect's `Semaphore` interface, durable backing)

```ts
import * as Semaphore from "effect/Semaphore"

export const DurableSemaphore: {
  readonly make: (options: {
    readonly permits: number
    readonly streamUrl: string
    readonly contentType?: string
  }) => Effect.Effect<Semaphore.Semaphore, DurableTableError, Scope.Scope>
}
```

- Stores a single durable permits-table (rows: `{ permitId, holderId,
  takenAt, releasedAt? }`).
- `take(n)` writes `n` claim rows (or one row with `permits: n` —
  implementation detail) and suspends durably if the materialized
  outstanding count exceeds `permits - n`.
- `release(n)` writes release rows; durably-suspended takers resume in
  stream order.
- `withPermits(n)(effect)` = scope-bound take + release-on-exit, matching
  the in-memory contract: permits release on success, failure, *and*
  interruption (the work didn't keep its slot).

**Use cases:**

- *Cross-host process budget.* "This Firegrid environment runs at most
  100 concurrent runtime processes across all hosts." Today there is no
  such bound — see "Cross-references" #3 below.

### `DurablePartitionedSemaphore<K>` (Effect's interface, durable backing)

```ts
import * as PartitionedSemaphore from "effect/PartitionedSemaphore"

export const DurablePartitionedSemaphore: {
  readonly make: <K>(options: {
    readonly permits: number
    readonly streamUrl: string
    readonly contentType?: string
    readonly keySchema: Schema.Schema<K, string>
  }) => Effect.Effect<
    PartitionedSemaphore.PartitionedSemaphore<K>,
    DurableTableError,
    Scope.Scope
  >
}
```

- **Same semantics as the in-memory `PartitionedSemaphore`**: `permits` is
  a **global** budget shared across all partition keys; partition key
  determines round-robin fairness when permits are scarce. We don't
  re-define the contract.
- `keySchema` is required because the durable rows need a stable string
  encoding of `K` (mirrors `DurableTable.primaryKey`'s
  `Schema.transformOrFail` convention; see
  `firegrid-durable-tools.BOUNDARIES.6`).

**Use cases:**

- *Fair cross-host process budget across workflows.* "At most 100
  concurrent processes globally, distributed fairly across workflow names
  so a single noisy workflow can't monopolize the pool."
- *Fair process budget across capability classes.* Same shape with
  `keySchema = capabilityClass` ("GPU contexts" vs "CPU contexts").

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

### `DurableKeyedMutex<K>` (new primitive — scope-bound, release-on-exit)

```ts
export interface DurableKeyedMutex<K> {
  /**
   * Scope-bound durable mutual exclusion.
   *
   * Lifecycle:
   * - On entry: writes a holder row keyed by `K`. If a non-released
   *   holder row already exists for the same key, this caller suspends
   *   durably until the holder releases (or is transferred by the
   *   stale-holder policy).
   * - On Effect success, failure, OR interruption: writes a release
   *   row keyed by `K`. Other waiters in stream order resume.
   *
   * Backed by a server-side conditional append to the holder row's
   * stream (see "Substrate fence" below).
   *
   * NOTE: `withLock` is NOT a claim-before-side-effect checkpoint. If
   * the body fails or is interrupted, the lock releases and another
   * caller can acquire and re-run the body. Use `DurableClaim<K>` for
   * AtMostOnce side effects.
   */
  readonly withLock: <A, E, R>(
    key: K,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DurableLockError, R>

  /**
   * Non-suspending variant: try to acquire; if a non-released holder
   * exists, returns `Option.none` without suspending. Useful for "skip
   * if owned by another caller" code paths like the dispatcher's
   * eligibility check.
   */
  readonly tryWithLock: <A, E, R>(
    key: K,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | DurableLockError, R>
}

export const DurableKeyedMutex: {
  readonly make: <K>(options: {
    readonly streamUrl: string
    readonly contentType?: string
    readonly keySchema: Schema.Schema<K, string>
    /**
     * Optional stale-holder policy. If a holder row exists but its
     * holder is no longer live (per `HostPresenceView` or equivalent),
     * the lock may be transferred. v0 default: refuse takeover;
     * require explicit operator action.
     */
    readonly stalePolicy?: StaleHolderPolicy<K>
  }) => Effect.Effect<DurableKeyedMutex<K>, DurableTableError, Scope.Scope>
}
```

Why not a `Semaphore`-shaped interface for this?

- `Semaphore` and `PartitionedSemaphore` both express "shared budget";
  this primitive expresses "one holder per key." Capacity is not a knob.
- The existing in-memory community pattern for this is `Map<K,
  Semaphore.Semaphore>` with each entry at capacity 1 — a composition,
  not a primitive. The durable equivalent earns being its own type
  because the durability concerns (stale-holder takeover,
  release-on-failure semantics, the fenced acquire underneath) are
  load-bearing in the type's contract.

**Use cases:**

- *Per-context ownership in the runtime-host dispatcher.* "One host runs
  each contextId, releases the slot when the workflow execution
  terminates." This is the gap that
  `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md` is filling.
- *Future scope-bound mutual exclusion needs.* Anywhere a caller wants
  "one holder at a time per key, automatic release on body exit." If the
  caller needs AtMostOnce instead, use `DurableClaim<K>`.

### `DurableClaim<K>` vs `DurableKeyedMutex<K>`: the decision rule

When you reach for "I need to make sure only one X runs at a time," ask:

| Question | Use |
|---|---|
| Should the side effect ever run again across the whole lifetime of this key, even after process restart? | If **no**: `DurableClaim<K>`. If **yes**: `DurableKeyedMutex<K>`. |
| Does releasing-on-failure (so a retryer can take over) match the desired semantic? | If **yes**: `DurableKeyedMutex<K>`. If **no**: `DurableClaim<K>`. |
| Does the body have a natural "I'm done with this resource" terminal point that should free the slot? | If **yes**: `DurableKeyedMutex<K>` (release-on-exit). If **no**: `DurableClaim<K>` (explicit `retire` only). |

Examples:

- *AtMostOnce stdin delivery.* Bytes are written-once. Even if the
  delivery body crashes mid-way, restart must NOT retry. → `DurableClaim`.
- *Activity claim.* Whoever wins the race owns the result row forever.
  → `DurableClaim`.
- *Dispatcher contextId ownership.* When the workflow terminates
  normally, the slot frees for future cluster operations. If the
  workflow body fails, another host (after stale-owner detection)
  should retry. → `DurableKeyedMutex`.

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

### 3. Flamecast toy host duplicate-suppression → `DurableKeyedMutex<contextId>`

**Where:** `apps/flamecast/src/runtime/host.ts:35-54`.

**What's there today:** A local `Set<string>` of running context ids, an
async `shouldStart(contextId)` snapshot check, and an `Effect.ensuring`
cleanup that removes from the set on exit.

This is structurally correct *for a single host process* but cannot
prevent two hosts pointed at the same namespace from both calling
`startRuntime` on the same context — exactly the failure mode the
dispatcher SDD describes.

**Lifecycle: scope-bound, release on exit.** When the workflow
terminates, the slot should free; if the host process dies mid-flight,
stale-owner detection should hand ownership to another host. That's
mutex with stale-holder policy, not a write-once claim.

**What it becomes with `DurableKeyedMutex<contextId>`:**

```ts
yield* mutex.tryWithLock(context.contextId,
  startRuntime({ contextId: context.contextId }),
).pipe(
  Effect.tap(Option.match({
    onNone: () => Effect.void,    // Another host won the lock; skip.
    onSome: () => Effect.void,    // We owned the lock and ran the work.
  })),
  Effect.forkScoped,
)
```

The `Set<contextId>` becomes optional (in-process belt-and-braces; the
durable lock is the load-bearing fence). The `shouldStart` snapshot
check stays as eligibility filtering for terminal contexts (`status ===
"exited"`); it is no longer doing concurrency control.

### 4. Wait/completion rows in `wait_for` (not a claim — for clarity)

**Where:** `packages/runtime/src/durable-tools/internal/`.

These rows are a durable rendezvous (workflow suspends on a
`DurableDeferred`, router resolves it), **not** a claim-before-side-effect
gate. They do not migrate to either primitive. Documenting this here
so future readers don't conflate the three patterns
(`DurableClaim` / `DurableKeyedMutex` / durable workflow deferred).

## Integration with the dispatcher SDD

`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md` is the canonical
first customer. Rather than each part of the dispatcher inventing claim
mechanics, the SDD should consume these primitives:

### The dispatcher's "Claim Lifecycle" section maps to:

| SDD step | Primitive | Notes |
|---|---|---|
| 1. Observe context + run state | `RuntimeControlPlaneTable` materialization | Unchanged. |
| 2. Skip terminal/incompatible contexts | Eligibility filter (no claim primitive) | Unchanged. |
| 3. Append a claim with this host id | `DurableKeyedMutex<contextId>.tryWithLock` | Replaces the "append-only claim facts + first-by-stream materialized winner" implementation detail with a typed primitive. The materialization rules are now the primitive's implementation, not the dispatcher's. |
| 4. Observe claim rows through the materializer | (internal to the primitive) | The dispatcher does not see claim rows directly; it just sees `Option.some` (we won) or `Option.none` (another host won). |
| 5. If this host is the winner, schedule execution once | The `Option.some` branch | The `withLock` scope ensures release-on-exit regardless of success/failure/interruption. |
| 6. If another live host owns the winner claim, skip | The `Option.none` branch | No-op; come back when the claim releases. |
| 7. Dead-owner takeover | `stalePolicy` option on the mutex | v0: refuse takeover (default). v1: pluggable stale-holder policy that consumes `HostPresenceView`. |
| 8. Start runtime attempt after ownership established | Inside the `tryWithLock` body | `startRuntime({ contextId, claimId, hostId, fenceToken, epoch })` — fence metadata is what the primitive emits. |
| 9. Write run + output rows | Existing tables | Unchanged. |

### What this changes in the SDD

The dispatcher SDD currently describes claim mechanics in some detail
(separate `claims`, `claimOutcomes` collections; first-claim-by-stream
projection; release/expired/transferred evidence rows). The proposed
primitives absorb most of that:

- `claims` and `claimOutcomes` rows become the implementation detail of
  `DurableKeyedMutex` — the dispatcher no longer reasons about them
  directly.
- `HostPresenceView` stays as-is and feeds `stalePolicy`.
- The dispatcher's job shrinks to: "subscribe to eligible contexts,
  `tryWithLock` each one, run if we won, skip if we didn't."

That's a significant simplification. It also means the dispatcher SDD
gains a clean separation between **substrate** (the mutex; durable
mechanics) and **policy** (eligibility, stale-holder rules, dispatch
ordering) — the same separation Fireline's prior art recommends.

### Where the dispatcher uses each primitive

Cross-referencing the dispatcher SDD's concerns to the relevant primitives
(`DurableClaim` is not in this table because the dispatcher uses
release-on-exit semantics, not write-once):

| Concern | Primitive | Partition key (if applicable) | Notes |
|---|---|---|---|
| Cross-host mutual exclusion ("one host runs each contextId") | `DurableKeyedMutex<contextId>` | n/a (keyed mutex isolates per key) | The load-bearing dispatcher fence. |
| Per-host process budget ("this host runs at most 4 concurrent contexts") | `Semaphore` (in-memory) | n/a | In-process throttling. Doesn't need to be durable; only this host process sees it. |
| Cluster-wide process budget ("this Firegrid environment runs at most 100 concurrent contexts") | `DurableSemaphore` | n/a | Optional. Useful if there's an external resource constraint (sandbox quotas, license limits). Not in the dispatcher SDD today. |
| Cluster-wide fair share across workflows ("no single workflow monopolizes the pool") | `DurablePartitionedSemaphore<workflowName>` | `workflowName` | Optional. Fairness layer on top of the cluster budget. |
| In-process duplicate suppression ("don't launch this contextId twice in this process") | Optional `Set<contextId>` or per-key in-process latch | n/a | Belt-and-braces; the durable mutex is the load-bearing fence. |

The dispatcher's *required* dependency is `DurableKeyedMutex<contextId>`.
`DurableSemaphore` and `DurablePartitionedSemaphore` are optional layers
that the SDD can name as future-work without blocking on.

## Implementation precondition: substrate fence

### What the fence has to be

All four primitives need a **server-side conditional append** to be
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
It is **wrong for the dispatcher and for `DurableClaim`**, both of which
need hard mutual exclusion / AtMostOnce without an external idempotency
oracle.

This proposal recommends **amending `BOUNDARIES.8`** to permit a
`DurableTable.insertIfAbsent(row)` action returning
`Effect<{ inserted: boolean }, DurableTableError>`. The amendment
justification: the dispatcher is the load-bearing customer that
demonstrates the primitive is necessary; the activity-claim and
stdin-delivery sites demonstrate the pattern already exists in
production code via raw `DurableStream.producer` workarounds.

### Two implementation paths

**Path A — single-host / dev only, not dispatcher-correct.**

A first iteration of the primitives could be built on existing
`DurableTable.upsert` plus a local in-process holder map. This is
adequate for:

- Tests running in a single process (one in-memory `Map<K, ...>` is the
  fence).
- Single-host smoke tests of the dispatcher SDD's eligibility filter and
  rollout choreography.

It is **not** adequate for the dispatcher's stated multi-host
correctness invariants. Two hosts with their own in-process maps will
each "win" the local check and each call `startRuntime`, exactly the
failure mode the dispatcher SDD is intended to fix. The materializer
trick — "both writers append; whoever has the lower stream offset is the
winner" — requires `DurableTable` (or the underlying substrate) to
expose stable, monotonic, cross-host-consistent ordering metadata on
materialized change events, **which is not in the public surface today**.
Until that metadata is exposed *and* the consumers downstream of a
duplicate write are confirmed idempotent against the would-be-loser's
row, Path A cannot be presented as multi-host correct.

Practical implication: shipping Path A primitives and asking the
dispatcher to depend on them re-introduces the multi-host duplicate-execution
failure mode the dispatcher SDD is designed to eliminate. **Do not ship
the dispatcher on Path A.**

**Path B — canonical, multi-host correct, requires `BOUNDARIES.8`
amendment.**

- Add `DurableTable.insertIfAbsent` as a generated action alongside
  `insert` / `upsert` / `delete`.
- Map each `insertIfAbsent` to a Durable Streams idempotent-producer
  append addressed by a deterministic producerId derived from the row's
  primary key (the same fence mechanism the activity-claim path uses
  today, lifted into a typed action).
- Implement all four concurrency primitives over `insertIfAbsent`.
- This is the **only** multi-host-correct implementation.

**Recommended path:** **Path B is the only path for shipping the
dispatcher.** Path A is acceptable for `DurableClaim`'s single-host call
sites (stdin delivery, single-host activity claims) and for early
in-process smoke tests of the primitives' Effect-shaped surfaces, but
the public migrations of those call sites should also wait for Path B
so the test matrix doesn't fork between "Path A wrapper" and "Path B
wrapper" versions. Land Path B once; migrate consumers once.

## Sequencing recommendation for the coordinator

1. **Amend `firegrid-durable-tools.BOUNDARIES.8`** as a docs-only spec
   PR. Justification: this proposal (`DurableClaim` migration of two
   existing sites) + the dispatcher SDD (`DurableKeyedMutex`) as
   concrete load-bearing customers.
2. **Add `DurableTable.insertIfAbsent`** to `effect-durable-operators`,
   implemented over the Durable Streams idempotent-producer append. New
   spec ACID under `effect-durable-operators.TABLE.*` documenting the
   semantic: server-side conditional append, typed
   `{ inserted: boolean }` result, conflict visibility on the wire. The
   impl PR should include the smoke test confirming duplicate
   `insertIfAbsent` returns a distinguishable conflict.
3. **Implement `DurableClaim<K>`** under `effect-durable-operators`. Two
   day-one consumers (activity claims, stdin delivery) meet the
   promotion bar.
4. **Implement `DurableKeyedMutex<K>`** under `effect-durable-operators`
   alongside. Day-one consumer: the dispatcher. The Flamecast toy host
   becomes the second consumer when its watcher moves into
   `@firegrid/runtime`.
5. **Implement `DurableSemaphore` and `DurablePartitionedSemaphore<K>`**
   alongside, since the implementation cost is incremental once the
   underlying `insertIfAbsent` exists. No required day-one consumers;
   these unlock optional future-work fairness layers in the dispatcher
   SDD.
6. **Migrate the two `DurableClaim` sites** (activity claims, ingress
   stdin delivery). This validates the primitive against real call sites
   and removes the only raw-`DurableStream.producer.append` path in
   production runtime code.
7. **Rewrite the dispatcher SDD's "Claim Lifecycle"** section to consume
   `DurableKeyedMutex` by name. The SDD shrinks substantially — most of
   the existing claim/release/expired/transferred row design becomes
   the mutex's implementation detail.
8. **Implement the dispatcher** on `DurableKeyedMutex<contextId>`. Move
   Flamecast's host watcher into `@firegrid/runtime` and delete the
   in-process `Set<contextId>` (it becomes optional belt-and-braces;
   the durable mutex is the load-bearing fence).

Steps 3–6 can be combined into one PR; the promotion bar to
`effect-durable-operators` is met by the existing migrations, and
landing the primitives in the same PR as the migrations proves the API
shape against real call sites before the dispatcher consumes it.

## Non-goals

- This proposal does **not** suggest a generic durable-state framework.
  Each tool keeps its typed `DurableTable` row schemas; the primitives
  are utilities, not service planes.
- This proposal does **not** unify `wait_for`'s wait/completion rows
  with claim semantics. Waits and completions are a durable rendezvous,
  not a claim-before-side-effect gate (see Cross-references #4).
- This proposal does **not** add concurrency primitives outside the
  four named. If a future product surface needs durable-fair queueing,
  durable rate limiting, or durable circuit-breaking, those are
  separate proposals against the Effect upstream equivalents
  (`RateLimiter`, etc.).
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
   `effect-durable-operators` from day one. `DurableClaim` has two
   day-one consumers (activity claims, stdin delivery); `DurableKeyedMutex`
   has one required day-one consumer (the dispatcher) plus the Flamecast
   toy host as a secondary consumer once it moves into `@firegrid/runtime`.
   Promotion bar is met if we count across both primitives.
3. **Path A first or Path B first?** Path A is **not multi-host
   correct** for either `DurableClaim` or `DurableKeyedMutex`; shipping
   the dispatcher on Path A would re-introduce the duplicate-execution
   failure mode the dispatcher SDD is intended to fix. Recommendation:
   land Path B once; do not ship the dispatcher on Path A. If unblocking
   in-process smoke testing requires shipping the primitive surfaces
   sooner, a Path A implementation can be marked
   `@experimental.singleHostOnly` with explicit refusal to acquire when
   it detects another live host, but the migrations of real consumers
   should wait for Path B.
4. **Should `DurableClaim` or `DurableKeyedMutex` be type-compatible
   with any Effect primitive?** There's no exact match in the upstream
   library today. Recommendation: don't force compatibility;
   `withClaim(key, holderId, effect)` / `withLock(key, effect)` /
   `tryWithLock(key, effect)` are small, self-explanatory contracts.
   Revisit if Effect adds a similar primitive upstream.
5. **Stale-holder policy plumbing.** The `stalePolicy` callback needs
   access to the dispatcher's `HostPresenceView`. Does the policy live
   in `effect-durable-operators` (generic shape) or in
   `@firegrid/runtime` (Firegrid-specific HostPresenceView consumer)?
   Recommendation: generic shape in operators package
   (`StaleHolderPolicy<K> = (key: K, holderEvidence: unknown) =>
   Effect<HolderState>`), Firegrid-specific implementation lives where
   `HostPresenceView` lives.
